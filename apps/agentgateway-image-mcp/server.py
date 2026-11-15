"""Text-to-image MCP adapter; billing and aliases stay on the existing gateway."""

import asyncio
import base64
import hmac
import json
import logging
import os
from typing import Annotated, Literal

import httpx
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, ImageContent, JSONRPCResponse, TextContent
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
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_MCP_RESPONSE_BYTES = 10 * 1024 * 1024
IMAGE_DOWNLOAD_TIMEOUT = 5
# HTTPX request logs otherwise include signed image URL query strings.
logging.getLogger("httpx").setLevel(logging.WARNING)
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


async def image_preview(url: str) -> ImageContent:
    allowed_hosts = {
        host.strip().lower() for host in os.environ.get("MCP_IMAGE_ALLOWED_HOSTS", "").split(",") if host.strip()
    }
    address = httpx.URL(url)
    if (
        address.scheme != "https"
        or address.host not in allowed_hosts
        or address.username
        or address.password
        or address.port not in (None, 443)
    ):
        raise ValueError("Image address is not allowed.")
    async with asyncio.timeout(IMAGE_DOWNLOAD_TIMEOUT):
        # Keep image downloads separate from the authenticated generation client.
        async with httpx.AsyncClient(timeout=IMAGE_DOWNLOAD_TIMEOUT, trust_env=False, follow_redirects=False) as client:
            async with client.stream("GET", address, headers={"Accept-Encoding": "identity"}) as response:
                if response.status_code != 200:
                    raise ValueError("Image download did not return HTTP 200.")
                mime_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                if mime_type not in ("image/png", "image/jpeg"):
                    raise ValueError("Image type is not supported.")
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise ValueError("Encoded image downloads are not supported.")
                if int(response.headers.get("content-length", "0")) > MAX_IMAGE_BYTES:
                    raise ValueError("Image exceeds the inline limit.")
                image = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                    if len(image) + len(chunk) > MAX_IMAGE_BYTES:
                        raise ValueError("Image exceeds the inline limit.")
                    image.extend(chunk)
                signature = b"\x89PNG\r\n\x1a\n" if mime_type == "image/png" else b"\xff\xd8\xff"
                if not image.startswith(signature):
                    raise ValueError("Image signature does not match its type.")
                return ImageContent(type="image", mimeType=mime_type, data=base64.b64encode(image).decode("ascii"))


def response_bytes(result: CallToolResult) -> int:
    try:
        request_id = mcp.get_context().request_context.request_id
    except ValueError:
        request_id = 0  # Direct, in-process calls have no protocol envelope.
    message = JSONRPCResponse(
        jsonrpc="2.0", id=request_id, result=result.model_dump(by_alias=True, exclude_none=True),
    )
    return len(message.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8"))


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request):
    return PlainTextResponse("ok")


@mcp.tool(
    description="Generate one image through VKE Agentgateway and Ark, returning its URL and an inline preview when available. "
    "This incurs image-generation charges; call only when the user explicitly requests an image."
)
async def generate_image(
    prompt: Annotated[str, Field(min_length=1, max_length=8000)],
    model: Model = "doubao-seedream-5.0-flash",
    size: Annotated[str, Field(pattern=r"^(1K|2K|4K|[1-9][0-9]{2,3}x[1-9][0-9]{2,3})$")] = "1K",
    output_format: Literal["png", "jpeg"] = "png",
    watermark: bool = True,
) -> CallToolResult:
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
                **(
                    {"sequential_image_generation": "disabled"}
                    if model in ("doubao-seedream-5.0-lite", "doubao-seedream-4.5", "doubao-seedream-4.0")
                    else {}
                ),
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
    result = CallToolResult(
        structuredContent=data,
        content=[TextContent(type="text", text=json.dumps(data))],
    )
    try:
        result.content.append(await image_preview(data["data"][0]["url"]))
    except (httpx.HTTPError, httpx.InvalidURL, ValueError, TimeoutError):
        # A missing preview must not retry or invalidate a potentially billed generation.
        result.content.append(TextContent(type="text", text="Inline preview unavailable; use the original image URL."))
    if response_bytes(result) > MAX_MCP_RESPONSE_BYTES:
        unavailable = TextContent(type="text", text="Inline preview unavailable; use the original image URL.")
        result.content = [result.content[0], unavailable]
        if response_bytes(result) > MAX_MCP_RESPONSE_BYTES:
            # Oversized metadata must not prevent returning the generated image URLs.
            urls = {"data": [{"url": item["url"]} for item in data["data"]]}
            result = CallToolResult(
                structuredContent=urls,
                content=[TextContent(type="text", text=json.dumps(urls)), unavailable],
            )
    return result


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
