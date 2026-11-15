import importlib.util
import os
import unittest
from unittest.mock import patch

import httpx

spec = importlib.util.spec_from_file_location(
    "image_router", os.path.join(os.path.dirname(__file__), "server.py")
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
RealClient = httpx.AsyncClient


class ImageRouterTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, payload, handler, env=None):
        credentials = {
            "THIRDPARTY_AUTHORIZATION": "Bearer test-image-key",
            "ARK_AUTHORIZATION": "Bearer test-ark-key",
        }
        if env is not None:
            credentials = env
        with patch.dict(os.environ, credentials, clear=True):
            with patch.object(
                server.httpx,
                "AsyncClient",
                lambda **kwargs: RealClient(
                    transport=httpx.MockTransport(handler), **kwargs
                ),
            ):
                async with RealClient(
                    transport=httpx.ASGITransport(app=server.app),
                    base_url="http://router",
                ) as client:
                    return await client.post("/v1/images/generations", json=payload)

    async def test_routes_gpt_image_to_thirdparty(self):
        def handle(request):
            self.assertEqual(
                str(request.url),
                "https://third-party-upstream.example.com/v1/images/generations",
            )
            self.assertEqual(request.headers["authorization"], "Bearer test-image-key")
            return httpx.Response(200, json={"data": [{"b64_json": "abc"}]})

        response = await self.request(
            {"model": "gpt-image-2", "prompt": "cat"}, handle
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-ark-channel"], "thirdparty-image")

    async def test_routes_seedream_to_ark(self):
        def handle(request):
            self.assertEqual(
                str(request.url),
                "https://ark.cn-beijing.volces.com/api/v3/images/generations",
            )
            self.assertEqual(request.headers["authorization"], "Bearer test-ark-key")
            return httpx.Response(
                400, json={"error": {"message": "prompt required"}}
            )

        response = await self.request({"model": "doubao-seedream-5.0-pro"}, handle)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.headers["x-ark-channel"], "ark-media-payg")

    async def test_rejects_unknown_model_without_upstream_call(self):
        def handle(request):
            self.fail("unknown models must not reach an upstream")

        response = await self.request({"model": "unknown"}, handle)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Unsupported image model", response.text)

    async def test_requires_model(self):
        def handle(request):
            self.fail("missing models must not reach an upstream")

        response = await self.request({"prompt": "cat"}, handle)
        self.assertEqual(response.status_code, 400)
        self.assertIn("model field is required", response.text)

    async def test_missing_credentials_are_sanitized(self):
        def handle(request):
            self.fail("missing credentials must not reach an upstream")

        response = await self.request(
            {"model": "gpt-image-2", "prompt": "cat"}, handle, env={}
        )
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("THIRDPARTY_AUTHORIZATION", response.text)

    async def test_upstream_failure_is_not_retried_or_leaked(self):
        calls = []

        def handle(request):
            calls.append(request)
            raise httpx.ConnectError("sensitive upstream detail", request=request)

        response = await self.request(
            {"model": "gpt-image-2", "prompt": "cat"}, handle
        )
        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("sensitive", response.text)


if __name__ == "__main__":
    unittest.main()
