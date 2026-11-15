import asyncio
import base64
import json
import os
import unittest
from unittest.mock import patch

import httpx
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import JSONRPCResponse

import server

RealClient = httpx.AsyncClient
IMAGE_URL = "https://images.example.com/image.png"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII="
)


class ImageStream(httpx.AsyncByteStream):
    def __init__(self, chunks, delay=0):
        self.chunks = chunks
        self.delay = delay
        self.closed = False
        self.consumed = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            self.consumed += 1
            yield chunk

    async def aclose(self):
        self.closed = True


class ImageMcpTests(unittest.IsolatedAsyncioTestCase):
    async def preview_result(self, response, url=IMAGE_URL, images=None, metadata=None, preserve_body=True):
        calls = []
        body = {"data": images if images is not None else [{"url": url}], "usage": {"test": 1}}
        if metadata:
            body.update(metadata)

        def handle(request):
            calls.append(request)
            if request.method == "POST":
                self.assertEqual(request.headers["authorization"], "Bearer test-only")
                return httpx.Response(200, json=body)
            self.assertNotIn("authorization", request.headers)
            self.assertNotIn("x-api-key", request.headers)
            self.assertNotIn("cookie", request.headers)
            self.assertEqual(request.headers["accept-encoding"], "identity")
            self.assertEqual(request.url.host, "images.example.com")
            if isinstance(response, Exception):
                raise response
            return response

        def client(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            if kwargs["timeout"] != 180:
                self.assertFalse(kwargs["follow_redirects"])
                self.assertEqual(kwargs["timeout"], server.IMAGE_DOWNLOAD_TIMEOUT)
            return RealClient(transport=httpx.MockTransport(handle), **kwargs)

        with patch.dict(os.environ, {
            "AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}',
            "MCP_IMAGE_ALLOWED_HOSTS": "images.example.com",
            "HTTPS_PROXY": "http://untrusted.example.com",
        }), patch.object(server.httpx, "AsyncClient", client):
            result = await server.generate_image("a cat")
        self.assertEqual(sum(request.method == "POST" for request in calls), 1)
        self.assertFalse(result.isError)
        if preserve_body:
            self.assertEqual(result.structuredContent, body)
            self.assertEqual(json.loads(result.content[0].text), body)
        return result, calls

    async def test_serialized_response_budget_includes_image_json_and_envelope(self):
        response = lambda: httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
        result, _ = await self.preview_result(response())
        size = len(JSONRPCResponse(
            jsonrpc="2.0", id=0, result=result.model_dump(by_alias=True, exclude_none=True),
        ).model_dump_json(by_alias=True, exclude_none=True).encode())
        for limit, types in [(size, ["text", "image"]), (size - 1, ["text", "text"])]:
            with self.subTest(limit=limit), patch.object(server, "MAX_MCP_RESPONSE_BYTES", limit):
                result, calls = await self.preview_result(response())
                self.assertEqual([block.type for block in result.content], types)
                self.assertLessEqual(server.response_bytes(result), limit)
                self.assertEqual(len(calls), 2)

    async def test_oversized_metadata_falls_back_to_urls_without_retry(self):
        result, calls = await self.preview_result(
            httpx.Response(200, content=PNG, headers={"content-type": "image/png"}),
            metadata={"extra": "x" * (6 * 1024 * 1024)}, preserve_body=False,
        )
        urls = {"data": [{"url": IMAGE_URL}]}
        self.assertEqual(result.structuredContent, urls)
        self.assertEqual(json.loads(result.content[0].text), urls)
        self.assertEqual([block.type for block in result.content], ["text", "text"])
        self.assertLessEqual(server.response_bytes(result), 10 * 1024 * 1024)
        self.assertEqual(len(calls), 2)

    async def test_oversized_image_response_keeps_metadata_when_it_fits_without_image(self):
        result, calls = await self.preview_result(
            httpx.Response(200, stream=ImageStream([
                PNG, b"x" * (server.MAX_IMAGE_BYTES - len(PNG)),
            ]), headers={"content-type": "image/png"}),
            metadata={"extra": "猫" * (400 * 1024)},
        )
        self.assertEqual([block.type for block in result.content], ["text", "text"])
        self.assertLessEqual(server.response_bytes(result), server.MAX_MCP_RESPONSE_BYTES)
        self.assertEqual(len(calls), 2)

    async def test_preview_success_and_first_image_only(self):
        for mime, image in [("image/png; charset=binary", PNG), ("image/jpeg", b"\xff\xd8\xff\xe0test")]:
            with self.subTest(mime=mime):
                result, calls = await self.preview_result(
                    httpx.Response(200, content=image, headers={"content-type": mime}),
                    images=[{"url": IMAGE_URL}, {"url": "https://other.example.com/second.png"}],
                )
                self.assertEqual(len(calls), 2)
                self.assertEqual([block.type for block in result.content], ["text", "image"])
                self.assertEqual(result.content[1].mimeType, mime.split(";")[0])
                self.assertEqual(base64.b64decode(result.content[1].data), image)

    async def test_inline_size_boundary_and_stream_limit(self):
        self.assertEqual(server.MAX_IMAGE_BYTES, 10 * 1024 * 1024)
        self.assertEqual(server.MAX_IMAGE_BYTES, server.MAX_MCP_RESPONSE_BYTES)
        at_limit = PNG + b"\0" * (server.MAX_IMAGE_BYTES - len(PNG))
        for extra in (0, 1, 64 * 1024):
            with self.subTest(extra=extra):
                stream = ImageStream([at_limit, b"x" * extra])
                if extra == 64 * 1024:
                    stream.chunks.append(b"not consumed")
                # Isolate the download cap from the encoded response budget.
                with patch.object(server, "MAX_MCP_RESPONSE_BYTES", 20 * 1024 * 1024):
                    result, _ = await self.preview_result(httpx.Response(
                        200, stream=stream, headers={"content-type": "image/png"},
                    ))
                self.assertEqual(result.content[1].type, "image" if not extra else "text")
                self.assertTrue(stream.closed)
                if extra == 64 * 1024:
                    self.assertLess(stream.consumed, 3)

    async def test_larger_downloads_respect_encoded_response_budget(self):
        for size, types in [
            (6 * 1024 * 1024, ["text", "image"]),
            (10 * 1024 * 1024, ["text", "text"]),
        ]:
            with self.subTest(size=size):
                image = PNG + b"\0" * (size - len(PNG))
                result, calls = await self.preview_result(httpx.Response(
                    200, content=image, headers={"content-type": "image/png"},
                ))
                self.assertEqual([block.type for block in result.content], types)
                self.assertLessEqual(server.response_bytes(result), server.MAX_MCP_RESPONSE_BYTES)
                self.assertEqual(len(calls), 2)

    async def test_preview_failures_preserve_success_and_do_not_retry(self):
        for response in [
            httpx.Response(302, headers={"location": "https://images.example.com/redirect"}),
            httpx.Response(404),
            httpx.Response(200, content=PNG, headers={"content-type": "image/gif"}),
            httpx.Response(200, content=b"invalid", headers={"content-type": "image/png"}),
            httpx.Response(200, content=PNG, headers={"content-type": "image/jpeg"}),
            httpx.Response(200, content=b"", headers={"content-type": "image/png"}),
            httpx.Response(200, content=PNG, headers={"content-type": "image/png", "content-length": "invalid"}),
            httpx.Response(200, stream=ImageStream([PNG]), headers={
                "content-type": "image/png", "content-length": str(server.MAX_IMAGE_BYTES + 1),
            }),
            httpx.Response(200, stream=ImageStream([PNG]), headers={
                "content-type": "image/png", "content-encoding": "gzip",
            }),
            httpx.ConnectError("private upstream details"),
            httpx.ReadTimeout("private upstream details"),
        ]:
            with self.subTest(response=response):
                result, calls = await self.preview_result(response)
                self.assertEqual(len(calls), 2)
                self.assertEqual([block.type for block in result.content], ["text", "text"])
                self.assertEqual(result.content[1].text, "Inline preview unavailable; use the original image URL.")

    async def test_untrusted_addresses_are_not_downloaded(self):
        for url in [
            "http://images.example.com/image.png",
            "https://images.example.com.evil.com/image.png",
            "https://sub.images.example.com/image.png",
            "https://user:password@images.example.com/image.png",
            "https://images.example.com:8443/image.png",
            "https://127.0.0.1/image.png",
            "https://[::1]/image.png",
            "file:///etc/passwd",
            "not a URL",
            "https://images.example.com/\n",
        ]:
            with self.subTest(url=url):
                result, calls = await self.preview_result(httpx.Response(200), url=url)
                self.assertEqual(len(calls), 1)
                self.assertEqual(result.content[1].type, "text")

    async def test_total_timeout_closes_download(self):
        stream = ImageStream([PNG] * 10, delay=0.02)
        with patch.object(server, "IMAGE_DOWNLOAD_TIMEOUT", 0.05):
            result, calls = await self.preview_result(httpx.Response(
                200, stream=stream, headers={"content-type": "image/png"},
            ))
        self.assertEqual(len(calls), 2)
        self.assertEqual(result.content[1].type, "text")
        self.assertTrue(stream.closed)
        self.assertLess(stream.consumed, 10)

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

        with patch.dict(os.environ, {
            "AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}', "MCP_IMAGE_ALLOWED_HOSTS": "",
        }):
            with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(transport=httpx.MockTransport(handle), **kw)):
                result = await server.generate_image("a cat")
        self.assertEqual(result.structuredContent["data"][0]["url"], "https://example.com/image.png")
        self.assertEqual([block.type for block in result.content], ["text", "text"])

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
                    calls = []

                    def handle(request):
                        calls.append(request.method)
                        if request.method == "POST":
                            return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
                        self.assertNotIn("authorization", request.headers)
                        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

                    with patch.dict(os.environ, {
                        "AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}',
                        "MCP_IMAGE_ALLOWED_HOSTS": "images.example.com",
                    }), patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(
                        transport=httpx.MockTransport(handle), **kw,
                    )):
                        called = await client.post("/mcp/", json={
                            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                            "params": {"name": "generate_image", "arguments": {"prompt": "a cat"}},
                        })
                    self.assertEqual(called.status_code, 200)
                    result = called.json()["result"]
                    self.assertFalse(result["isError"])
                    self.assertEqual([block["type"] for block in result["content"]], ["text", "image"])
                    self.assertEqual(base64.b64decode(result["content"][1]["data"]), PNG)
                    self.assertEqual(result["structuredContent"], json.loads(result["content"][0]["text"]))
                    self.assertEqual(calls, ["POST", "GET"])
                    request_id = "request-" + "x" * 1024
                    envelope = JSONRPCResponse(jsonrpc="2.0", id=request_id, result=result)
                    response_size = len(envelope.model_dump_json(by_alias=True, exclude_none=True).encode())
                    for limit, expected in [(response_size, ["text", "image"]), (response_size - 1, ["text", "text"])]:
                        with self.subTest(limit=limit), patch.object(server, "MAX_MCP_RESPONSE_BYTES", limit):
                            with patch.dict(os.environ, {
                                "AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}',
                                "MCP_IMAGE_ALLOWED_HOSTS": "images.example.com",
                            }), patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(
                                transport=httpx.MockTransport(handle), **kw,
                            )):
                                reply = await client.post("/mcp/", json={
                                    "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
                                    "params": {"name": "generate_image", "arguments": {"prompt": "a cat"}},
                                })
                        self.assertEqual(reply.status_code, 200)
                        self.assertEqual(reply.json()["id"], request_id)
                        self.assertEqual([block["type"] for block in reply.json()["result"]["content"]], expected)
                        self.assertLessEqual(len(reply.content), limit)


if __name__ == "__main__":
    unittest.main()
