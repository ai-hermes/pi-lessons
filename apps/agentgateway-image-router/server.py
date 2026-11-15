"""Route OpenAI-compatible image generation requests by model name."""

import json
import os
from dataclasses import dataclass

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route


@dataclass(frozen=True)
class Upstream:
    url: str
    authorization_env: str
    channel: str


def select_upstream(model: str) -> Upstream | None:
    """Map a public image model name to one upstream."""
    if model == "gpt-image-2":
        return Upstream(
            url="https://third-party-upstream.example.com/v1/images/generations",
            authorization_env="THIRDPARTY_AUTHORIZATION",
            channel="thirdparty-image",
        )
    if model.startswith("doubao-seedream-"):
        return Upstream(
            url="https://ark.cn-beijing.volces.com/api/v3/images/generations",
            authorization_env="ARK_AUTHORIZATION",
            channel="ark-media-payg",
        )
    return None


def error_response(message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        {"error": {"message": message, "type": "invalid_request_error"}},
        status_code=status_code,
    )


async def healthz(request: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


async def generate_image(request: Request) -> Response:
    try:
        body = await request.body()
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return error_response("Request body must be valid JSON.")

    if not isinstance(payload, dict) or not isinstance(payload.get("model"), str):
        return error_response("The model field is required.")

    upstream = select_upstream(payload["model"])
    if upstream is None:
        return error_response(f"Unsupported image model: {payload['model']}")

    authorization = os.environ.get(upstream.authorization_env)
    if not authorization:
        return error_response("Image upstream credentials are unavailable.", 503)

    try:
        async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
            response = await client.post(
                upstream.url,
                headers={
                    "Authorization": authorization,
                    "Content-Type": "application/json",
                },
                content=body,
            )
    except httpx.RequestError:
        # Never retry a request that may create a billable image.
        return error_response("The image upstream is unavailable.", 502)

    return Response(
        response.content,
        status_code=response.status_code,
        headers={
            "content-type": response.headers.get("content-type", "application/json"),
            "x-ark-channel": upstream.channel,
        },
    )


app = Starlette(
    routes=[
        Route("/healthz", healthz, methods=["GET"]),
        Route("/v1/images/generations", generate_image, methods=["POST"]),
    ]
)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
