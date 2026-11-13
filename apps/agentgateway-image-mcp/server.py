"""Text-to-image MCP adapter; billing and aliases stay on the existing gateway."""

import hmac
import json
import os
from typing import Annotated, Literal

import httpx
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse

Model = Literal[
    "doubao-seedream-5.0-pro",
    "doubao-seedream-5.0-flash",
    "doubao-seedream-5.0-lite",
    "doubao-seedream-4.5",
    "doubao-seedream-4.0",
]
mcp = FastMCP(
    "agentgateway-images",
    host="0.0.0.0",
    port=8000,
    streamable_http_path="/mcp/",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(
        allowed_hosts=[
            "ark-image-mcp.ark-gateway.svc.cluster.local",
            "ark-image-mcp.ark-gateway.svc.cluster.local:8000",
            "localhost:8000",
            "127.0.0.1:8000",
        ],
    ),
)


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request):
    return PlainTextResponse("ok")


@mcp.tool(
    description="Generate one image through VKE Agentgateway and Ark, returning its URL. "
    "This incurs image-generation charges; call only when the user explicitly requests an image."
)
async def generate_image(
    prompt: Annotated[str, Field(min_length=1, max_length=8000)],
    model: Model = "doubao-seedream-5.0-pro",
    size: Annotated[str, Field(pattern=r"^(1K|2K|4K|[1-9][0-9]{2,3}x[1-9][0-9]{2,3})$")] = "1K",
    output_format: Literal["png", "jpeg"] = "png",
    watermark: bool = True,
) -> dict:
    key = json.loads(os.environ["AGENTGATEWAY_CLIENT_CREDENTIAL"])["key"]
    async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
        response = await client.post(
            "http://agentgateway.agentgateway.svc.cluster.local:8080/v1/images/generations",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "prompt": prompt,
                "size": size,
                "output_format": output_format,
                "response_format": "url",
                "watermark": watermark,
                "sequential_image_generation": "disabled",
            },
        )
        if not response.is_success:
            # Do not retry a potentially billed generation or expose upstream response bodies.
            raise ValueError(f"Image API returned HTTP {response.status_code}; check gateway or Ark logs.")
        data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("data"), list) or not data["data"]:
            raise ValueError("Image API did not return image URLs.")
        if not all(isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"] for item in data["data"]):
            raise ValueError("Image API did not return image URLs.")
        return data


app = mcp.streamable_http_app()


async def require_gateway_auth(request, call_next):
    expected = os.environ.get("MCP_UPSTREAM_AUTHORIZATION", "")
    supplied = request.headers.get("authorization", "")
    if request.url.path != "/healthz" and (
        not expected or not hmac.compare_digest(supplied.encode(), expected.encode())
    ):
        return PlainTextResponse("Unauthorized", status_code=401)
    return await call_next(request)


app.add_middleware(BaseHTTPMiddleware, dispatch=require_gateway_auth)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
