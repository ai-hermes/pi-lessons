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
        self.chunks, self.delay = chunks, delay
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
    async def generate_result(self, body, model="doubao-seedream-5.0-flash", size="1K", download=None):
        calls = []

        def handle(request):
            calls.append(request)
            if request.method == "POST":
                self.assertEqual(request.url.path, "/v1/images/generations")
                self.assertEqual(request.headers["authorization"], "Bearer test-only")
                self.assertNotIn("x-image-provider", request.headers)
                return httpx.Response(200, json=body)
            self.assertEqual(request.method, "GET")
            for header in ("authorization", "x-api-key", "cookie", "x-image-provider"):
                self.assertNotIn(header, request.headers)
            self.assertEqual(request.headers["accept-encoding"], "identity")
            self.assertEqual(request.url.host, "images.example.com")
            if isinstance(download, Exception):
                raise download
            return download if download is not None else httpx.Response(
                200, content=PNG, headers={"content-type": "image/png"},
            )

        def client(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            if kwargs["timeout"] != 180:
                self.assertEqual(kwargs["timeout"], server.IMAGE_DOWNLOAD_TIMEOUT)
                self.assertFalse(kwargs["follow_redirects"])
            return RealClient(transport=httpx.MockTransport(handle), **kwargs)

        with patch.dict(os.environ, {
            "AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}',
            "MCP_IMAGE_ALLOWED_HOSTS": "images.example.com",
            "HTTPS_PROXY": "http://untrusted.example.com",
        }):
            with patch.object(server.httpx, "AsyncClient", client):
                result = await server.generate_image("a cat", model=model, size=size)
        self.assertEqual(sum(request.method == "POST" for request in calls), 1)
        self.assertFalse(result.isError)
        self.assertIsNone(result.structuredContent)
        self.assertEqual(len(result.content), 1)
        return result, calls

    async def test_models_return_only_first_image_block_without_metadata(self):
        for model in ["doubao-seedream-5.0-flash", "gpt-image-2"]:
            with self.subTest(model=model):
                urls = [IMAGE_URL, "https://other.example.com/second.png"]
                result, calls = await self.generate_result({
                    "data": [{"url": url} for url in urls],
                    "usage": {"extra": "x" * (6 * 1024 * 1024)},
                }, model=model)
                self.assertEqual([block.type for block in result.content], ["image"])
                self.assertEqual(base64.b64decode(result.content[0].data), PNG)
                self.assertEqual(result.content[0].mimeType, "image/png")
                self.assertEqual(len(calls), 2)
                self.assertNotIn(IMAGE_URL, result.model_dump_json())
                self.assertNotIn("usage", result.model_dump_json())

    async def test_model_specific_single_image_parameters(self):
        for model in (
            "doubao-seedream-5.0-pro", "doubao-seedream-5.0-flash",
            "doubao-seedream-5.0-lite", "doubao-seedream-4.5", "doubao-seedream-4.0",
        ):
            with self.subTest(model=model):
                result, calls = await self.generate_result({"data": [{"url": IMAGE_URL}]}, model=model)
                payload = json.loads(calls[0].content)
                self.assertEqual(payload["model"], model)
                self.assertEqual(payload["prompt"], "a cat")
                self.assertEqual(payload["response_format"], "url")
                if model in ("doubao-seedream-5.0-pro", "doubao-seedream-5.0-flash"):
                    self.assertNotIn("sequential_image_generation", payload)
                else:
                    self.assertEqual(payload["sequential_image_generation"], "disabled")
                self.assertEqual(result.content[0].type, "image")

    async def test_gpt_image_2_routing_sizes_and_native_base64(self):
        for size, upstream_size in [
            ("1K", "1024x1024"), ("2K", "2560x1440"), ("4K", "3840x2160"),
            ("1536x1024", "1536x1024"), ("auto", "auto"),
        ]:
            with self.subTest(size=size):
                result, calls = await self.generate_result(
                    {"data": [{"b64_json": base64.b64encode(PNG).decode()}]}, model="gpt-image-2", size=size,
                )
                self.assertEqual(json.loads(calls[0].content), {
                    "model": "gpt-image-2", "prompt": "a cat", "size": upstream_size,
                    "output_format": "png", "n": 1,
                })
                self.assertEqual(len(calls), 1)
                self.assertEqual(result.content[0].type, "image")
                self.assertEqual(base64.b64decode(result.content[0].data), PNG)

    async def test_invalid_base64_no_url_notice_without_retry(self):
        result, _ = await self.generate_result(
            {"data": [{"b64_json": "private-image-data"}]}, model="gpt-image-2",
        )
        self.assertIn("upstream returned no URL", result.content[0].text)
        self.assertIn("generation was not retried", result.content[0].text)
        self.assertNotIn("private-image-data", result.model_dump_json())

    async def test_invalid_base64_preserves_available_urls(self):
        result, _ = await self.generate_result({
            "data": [{"b64_json": "private-image-data"}, {"url": IMAGE_URL}],
        }, model="gpt-image-2")
        self.assertEqual(result.content[0].text, IMAGE_URL)

    async def test_response_budget_boundary_without_retry(self):
        body = {"data": [{"b64_json": base64.b64encode(PNG + b"x" * 1024).decode(), "url": IMAGE_URL}]}
        result, _ = await self.generate_result(body)
        boundary = server.response_bytes(result)
        self.assertEqual(server.MAX_MCP_RESPONSE_BYTES, 10 * 1024 * 1024)
        for limit, fits in [(boundary, True), (boundary - 1, False)]:
            with self.subTest(limit=limit), patch.object(server, "MAX_MCP_RESPONSE_BYTES", limit):
                result, _ = await self.generate_result(body)
                self.assertLessEqual(server.response_bytes(result), limit)
                if fits:
                    self.assertEqual(result.content[0].type, "image")
                else:
                    self.assertEqual(result.content[0].text, IMAGE_URL)

    async def test_native_base64_signature_and_size_failures(self):
        for image, mime in [(PNG, "image/png"), (b"\xff\xd8\xff\xe0test", "image/jpeg")]:
            encoded = base64.b64encode(image).decode()
            result, calls = await self.generate_result({"data": [{"b64_json": encoded, "url": IMAGE_URL}]})
            self.assertEqual(result.content[0].data, encoded)
            self.assertEqual(result.content[0].mimeType, mime)
            self.assertEqual(len(calls), 1)
        for encoded in [
            "invalid base64", base64.b64encode(b"not an image").decode(),
            "A" * (((server.MAX_IMAGE_BYTES + 2) // 3) * 4 + 4),
            base64.b64encode(PNG + b"x" * server.MAX_IMAGE_BYTES).decode(),
        ]:
            with self.subTest(length=len(encoded)):
                result, calls = await self.generate_result({"data": [{"b64_json": encoded}]}, model="gpt-image-2")
                self.assertEqual(result.content[0].type, "text")
                self.assertIn("upstream returned no URL", result.content[0].text)
                self.assertEqual(len(calls), 1)

    async def test_download_mime_and_signature(self):
        for mime, image in [("image/png; charset=binary", PNG), ("image/jpeg", b"\xff\xd8\xff\xe0test")]:
            with self.subTest(mime=mime):
                result, _ = await self.generate_result({"data": [{"url": IMAGE_URL}]}, download=httpx.Response(
                    200, content=image, headers={"content-type": mime},
                ))
                self.assertEqual(result.content[0].mimeType, mime.split(";")[0])
                self.assertEqual(base64.b64decode(result.content[0].data), image)

    async def test_download_failures_return_urls_without_retry(self):
        for download in [
            httpx.Response(302, headers={"location": IMAGE_URL + "/redirect"}),
            httpx.Response(404),
            httpx.Response(200, content=PNG, headers={"content-type": "image/gif"}),
            httpx.Response(200, content=b"invalid", headers={"content-type": "image/png"}),
            httpx.Response(200, content=PNG, headers={"content-type": "image/jpeg"}),
            httpx.Response(200, content=b"", headers={"content-type": "image/png"}),
            httpx.Response(200, content=PNG, headers={"content-type": "image/png", "content-length": "invalid"}),
            httpx.Response(200, content=PNG, headers={"content-type": "image/png", "content-length": str(server.MAX_IMAGE_BYTES + 1)}),
            httpx.Response(200, stream=ImageStream([PNG]), headers={"content-type": "image/png", "content-encoding": "gzip"}),
            httpx.ConnectError("private details"), httpx.ReadTimeout("private details"),
        ]:
            with self.subTest(download=download):
                result, calls = await self.generate_result({"data": [{"url": IMAGE_URL}]}, download=download)
                self.assertEqual(result.content[0].text, IMAGE_URL)
                self.assertEqual(len(calls), 2)

    async def test_untrusted_addresses_are_not_downloaded(self):
        for url in [
            "http://images.example.com/image.png", "https://images.example.com.evil.com/image.png",
            "https://sub.images.example.com/image.png", "https://user:password@images.example.com/image.png",
            "https://images.example.com:8443/image.png", "https://127.0.0.1/image.png",
            "https://[::1]/image.png", "file:///etc/passwd", "not a URL", "https://images.example.com/\n",
        ]:
            with self.subTest(url=url):
                result, calls = await self.generate_result({"data": [{"url": url}]})
                self.assertEqual(result.content[0].text, url)
                self.assertEqual(len(calls), 1)

    async def test_download_size_boundary_and_encoded_budget(self):
        self.assertEqual(server.MAX_IMAGE_BYTES, 10 * 1024 * 1024)
        at_limit = PNG + b"\0" * (server.MAX_IMAGE_BYTES - len(PNG))
        for extra in [0, 1, 64 * 1024]:
            stream = ImageStream([at_limit, b"x" * extra, b"not consumed"] if extra else [at_limit])
            with self.subTest(extra=extra), patch.object(server, "MAX_MCP_RESPONSE_BYTES", 20 * 1024 * 1024):
                result, _ = await self.generate_result({"data": [{"url": IMAGE_URL}]}, download=httpx.Response(
                    200, stream=stream, headers={"content-type": "image/png"},
                ))
            self.assertEqual(result.content[0].type, "image" if extra == 0 else "text")
            self.assertTrue(stream.closed)
            if extra == 64 * 1024:
                self.assertLess(stream.consumed, 3)
        for size, expected in [(6 * 1024 * 1024, "image"), (10 * 1024 * 1024, "text")]:
            result, _ = await self.generate_result({"data": [{"url": IMAGE_URL}]}, download=httpx.Response(
                200, content=PNG + b"\0" * (size - len(PNG)), headers={"content-type": "image/png"},
            ))
            self.assertEqual(result.content[0].type, expected)
            self.assertLessEqual(server.response_bytes(result), server.MAX_MCP_RESPONSE_BYTES)

    async def test_total_download_timeout(self):
        stream = ImageStream([PNG] * 10, delay=0.02)
        with patch.object(server, "IMAGE_DOWNLOAD_TIMEOUT", 0.05):
            result, _ = await self.generate_result({"data": [{"url": IMAGE_URL}]}, download=httpx.Response(
                200, stream=stream, headers={"content-type": "image/png"},
            ))
        self.assertEqual(result.content[0].text, IMAGE_URL)
        self.assertTrue(stream.closed)
        self.assertLess(stream.consumed, 10)

    async def test_gpt_invalid_sizes_fail_before_generation(self):
        with patch.object(server.httpx, "AsyncClient") as upstream:
            for size in ["1000x1000", "4096x2160", "1024x4096", "128x128", "3840x3840"]:
                with self.subTest(size=size), self.assertRaises(ToolError):
                    await server.mcp.call_tool("generate_image", {
                        "prompt": "a cat", "model": "gpt-image-2", "size": size,
                    })
            with self.assertRaises(ToolError):
                await server.mcp.call_tool("generate_image", {"prompt": "a cat", "size": "auto"})
            upstream.assert_not_called()

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
            with self.subTest(body=body):
                with self.assertRaisesRegex(ValueError, "did not return image URLs"):
                    await self.generate_result(body)

    async def test_tool_validation(self):
        with patch.object(server.httpx, "AsyncClient") as upstream:
            for arguments in [
                {"prompt": ""}, {"prompt": "cat", "model": "unknown"},
                {"prompt": "cat", "size": "invalid"}, {"prompt": "cat", "output_format": "gif"},
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

    async def test_authenticated_http_handshake_and_image_blocks(self):
        with patch.dict(os.environ, {"MCP_UPSTREAM_AUTHORIZATION": "Bearer test-only"}):
            async with server.app.router.lifespan_context(server.app):
                async with RealClient(
                    transport=httpx.ASGITransport(app=server.app), base_url="http://localhost:8000",
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
                    listed = await client.post("/mcp/", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
                    self.assertEqual(listed.status_code, 200)
                    tools = listed.json()["result"]["tools"]
                    self.assertEqual([tool["name"] for tool in tools], ["generate_image"])
                    self.assertIn("Base64 image block", tools[0]["description"])
                    self.assertEqual(tools[0]["inputSchema"]["properties"]["model"]["default"], "doubao-seedream-5.0-flash")
                    self.assertIn("gpt-image-2", tools[0]["inputSchema"]["properties"]["model"]["enum"])
                    for model, body, expected_calls in [
                        ("doubao-seedream-5.0-flash", {"data": [{"url": IMAGE_URL}]}, ["POST", "GET"]),
                        ("gpt-image-2", {"data": [{"url": IMAGE_URL}]}, ["POST", "GET"]),
                        ("gpt-image-2", {"data": [{"b64_json": base64.b64encode(PNG).decode()}]}, ["POST"]),
                    ]:
                        calls = []

                        def handle(request):
                            calls.append(request.method)
                            if request.method == "POST":
                                return httpx.Response(200, json=body)
                            self.assertNotIn("authorization", request.headers)
                            return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

                        with self.subTest(model=model, expected_calls=expected_calls):
                            with patch.dict(os.environ, {
                                "AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}',
                                "MCP_IMAGE_ALLOWED_HOSTS": "images.example.com",
                            }):
                                with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(
                                    transport=httpx.MockTransport(handle), **kw,
                                )):
                                    called = await client.post("/mcp/", json={
                                        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                        "params": {"name": "generate_image", "arguments": {"prompt": "a cat", "model": model}},
                                    })
                            self.assertEqual(called.status_code, 200)
                            result = called.json()["result"]
                            self.assertFalse(result["isError"])
                            self.assertEqual([block["type"] for block in result["content"]], ["image"])
                            self.assertNotIn("structuredContent", result)
                            self.assertNotIn(IMAGE_URL, called.text)
                            self.assertEqual(calls, expected_calls)
                            self.assertEqual(base64.b64decode(result["content"][0]["data"]), PNG)
                            self.assertEqual(result["content"][0]["mimeType"], "image/png")
                    request_id = "request-" + "x" * 1024
                    body = {"data": [{"url": IMAGE_URL, "b64_json": base64.b64encode(PNG + b"x" * 1024).decode()}]}
                    result, _ = await self.generate_result(body)
                    envelope = JSONRPCResponse(
                        jsonrpc="2.0", id=request_id, result=result.model_dump(by_alias=True, exclude_none=True),
                    )
                    boundary = len(envelope.model_dump_json(by_alias=True, exclude_none=True).encode())
                    for limit, fits in [(boundary, True), (boundary - 1, False)]:
                        with self.subTest(limit=limit), patch.object(server, "MAX_MCP_RESPONSE_BYTES", limit):
                            with patch.dict(os.environ, {"AGENTGATEWAY_CLIENT_CREDENTIAL": '{"key":"test-only"}'}):
                                with patch.object(server.httpx, "AsyncClient", lambda **kw: RealClient(
                                    transport=httpx.MockTransport(handle), **kw,
                                )):
                                    reply = await client.post("/mcp/", json={
                                        "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
                                        "params": {"name": "generate_image", "arguments": {"prompt": "a cat"}},
                                    })
                        self.assertEqual(reply.status_code, 200)
                        self.assertEqual(reply.json()["id"], request_id)
                        self.assertLessEqual(len(reply.content), limit)
                        block = reply.json()["result"]["content"][0]
                        if fits:
                            self.assertEqual(block["type"], "image")
                        else:
                            self.assertEqual(block["text"], IMAGE_URL)


if __name__ == "__main__":
    unittest.main()
