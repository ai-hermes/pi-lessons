import json
import os
import unittest
from unittest.mock import patch

import httpx
from mcp.server.fastmcp.exceptions import ToolError

import server

RealClient = httpx.AsyncClient


class ImageMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_and_url(self):
        def handle(request):
            self.assertEqual(request.url.path, "/v1/images/generations")
            self.assertEqual(request.headers["authorization"], "Bearer test-only")
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "doubao-seedream-5.0-flash")
            self.assertNotIn("sequential_image_generation", payload)
            self.assertEqual(payload["prompt"], "a cat")
            self.assertEqual(payload["response_format"], "url")
            return httpx.Response(200, json={"data": [{"url": "https://example.com/image.png"}]})

        with patch.dict(os.environ, {"AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}'}):
            with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(transport=httpx.MockTransport(handle), **kw)):
                result = await server.generate_image("a cat")
        self.assertEqual(result["data"][0]["url"], "https://example.com/image.png")

    async def test_model_specific_single_image_parameters(self):
        for model in (
            "doubao-seedream-5.0-pro",
            "doubao-seedream-5.0-flash",
            "doubao-seedream-5.0-lite",
            "doubao-seedream-4.5",
            "doubao-seedream-4.0",
        ):
            with self.subTest(model=model):
                def handle(request):
                    payload = json.loads(request.content)
                    self.assertEqual(payload["model"], model)
                    if model in ("doubao-seedream-5.0-pro", "doubao-seedream-5.0-flash"):
                        self.assertNotIn("sequential_image_generation", payload)
                    else:
                        self.assertEqual(payload["sequential_image_generation"], "disabled")
                    return httpx.Response(200, json={"data": [{"url": "https://example.com/image.png"}]})

                with patch.dict(os.environ, {"AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}'}):
                    with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(transport=httpx.MockTransport(handle), **kw)):
                        await server.generate_image("a cat", model=model)

    async def test_failure_not_retried_or_leaked(self):
        calls = []

        def handle(request):
            calls.append(request)
            return httpx.Response(429, text="secret upstream error")

        with patch.dict(os.environ, {"AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}'}):
            with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(transport=httpx.MockTransport(handle), **kw)):
                with self.assertRaisesRegex(ValueError, "HTTP 429") as caught:
                    await server.generate_image("a cat")
        self.assertEqual(len(calls), 1)
        self.assertNotIn("secret", str(caught.exception))

    async def test_malformed_upstream_response(self):
        for body in [{}, {"data": []}, {"data": [{}]}, {"data": [None]}, {"data": [{"url": 42}]}, []]:
            with self.subTest(body=body), patch.dict(os.environ, {"AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}'}):
                with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(
                    transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)), **kw
                )):
                    with self.assertRaisesRegex(ValueError, "did not return image URLs"):
                        await server.generate_image("a cat")

    async def test_tool_validation(self):
        with patch.object(server.httpx, "AsyncClient") as upstream:
            for arguments in [
                {"prompt": ""},
                {"prompt": "cat", "model": "unknown"},
                {"prompt": "cat", "size": "invalid"},
                {"prompt": "cat", "output_format": "gif"},
            ]:
                with self.subTest(arguments=arguments), self.assertRaises(ToolError):
                    await server.mcp.call_tool("generate_image", arguments)
            upstream.assert_not_called()

    async def test_direct_access_requires_backend_key(self):
        with patch.dict(os.environ, {"MCP_UPSTREAM_AUTHORIZATION": "Bearer test-only"}):
            async with RealClient(transport=httpx.ASGITransport(app=server.app), base_url="http://localhost:8000") as client:
                for headers in [{}, {"authorization": "Bearer wrong"}, {b"authorization": b"Bearer \xff"}]:
                    self.assertEqual((await client.post("/mcp", json={}, headers=headers)).status_code, 401)
                self.assertEqual((await client.get("/healthz")).status_code, 200)
                self.assertEqual((await client.get("/unknown", headers={"authorization": "Bearer test-only"})).status_code, 404)

    async def test_missing_server_key_fails_closed(self):
        with patch.dict(os.environ, {"MCP_UPSTREAM_AUTHORIZATION": ""}):
            async with RealClient(transport=httpx.ASGITransport(app=server.app), base_url="http://localhost:8000") as client:
                self.assertEqual((await client.post("/mcp", json={})).status_code, 401)

    async def test_authenticated_http_handshake_and_tool_listing(self):
        with patch.dict(os.environ, {"MCP_UPSTREAM_AUTHORIZATION": "Bearer test-only"}):
            async with server.app.router.lifespan_context(server.app):
                async with RealClient(
                    transport=httpx.ASGITransport(app=server.app),
                    base_url="http://localhost:8000",
                    headers={"Authorization": "Bearer test-only", "Accept": "application/json, text/event-stream"},
                ) as client:
                    initialized = await client.post("/mcp/", json={
                        "jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-03-26", "capabilities": {},
                            "clientInfo": {"name": "test-only", "version": "1"},
                        },
                    })
                    self.assertEqual(initialized.status_code, 200)
                    self.assertIn("protocolVersion", initialized.json()["result"])
                    listed = await client.post("/mcp/", json={
                        "jsonrpc": "2.0", "id": 2, "method": "tools/list",
                    })
                    self.assertEqual(listed.status_code, 200)
                    self.assertEqual([tool["name"] for tool in listed.json()["result"]["tools"]], ["generate_image"])
                    self.assertEqual(
                        listed.json()["result"]["tools"][0]["inputSchema"]["properties"]["model"]["default"],
                        "doubao-seedream-5.0-flash",
                    )


if __name__ == "__main__":
    unittest.main()
