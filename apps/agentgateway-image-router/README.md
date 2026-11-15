# Agentgateway image router

A small body-aware HTTP router for the OpenAI-compatible image endpoint. It
lets clients select an image provider with only the JSON `model` field. Clients
do not send a provider-routing header.

```text
POST /v1/images/generations
  -> HTTPRoute/ark-image-generation
  -> AgentgatewayBackend/image-model-router
  -> Service/agentgateway-image-router:8000
  -> Deployment/agentgateway-image-router
       gpt-image-2        -> thirdparty
       doubao-seedream-*  -> Ark
```

Gateway API `HTTPRoute` can match paths, methods, headers, and query parameters,
but it does not select a backend from a JSON request field. This service is the
body-aware routing seam.

## Behavior

| Public model | Upstream endpoint | Response channel |
| --- | --- | --- |
| `gpt-image-2` | `https://third-party-upstream.example.com/v1/images/generations` | `thirdparty-image` |
| `doubao-seedream-*` | `https://ark.cn-beijing.volces.com/api/v3/images/generations` | `ark-media-payg` |
| any other model | rejected before an upstream call | none |

The router forwards the upstream status and response body. It adds
`x-ark-channel` to the response for metrics and diagnostics. That response
header is not a routing input.

A possibly billable image request is never retried. Upstream network errors and
missing credentials return sanitized errors without endpoint or credential
details.

## Credentials

No API key is stored in this repository, image, manifest, test fixture, or
example command. Kubernetes injects complete `Authorization` header values from
existing Secrets:

- `thirdparty-image-key`, key `Authorization`
- `ark-payg-key`, key `Authorization`

Secret names and upstream URLs are configuration metadata, not credential
values. Create and rotate the actual values outside Git. Do not paste Secret
YAML, decoded data, terminal output, or shell history into this repository.

## Development

```bash
cd apps/agentgateway-image-router
uv venv --python 3.12
uv pip sync --require-hashes requirements.txt
.venv/bin/python -m unittest -v
```

Tests use fake credentials and `httpx.MockTransport`. They make no external
request and cannot create a billed image.

Refresh the dependency lock deliberately:

```bash
uv pip compile requirements.in \
  --generate-hashes \
  --output-file requirements.txt
```

Build locally:

```bash
docker build -t agentgateway-image-router:dev .
```

## Deployment record

`deploy/resources.yaml` records the Deployment, Service, NetworkPolicy, and
`AgentgatewayBackend`. `deploy/httproute.yaml` records the public image route.
They are environment-aware templates, not a portable one-command installer.

Set the image to an immutable digest before applying:

```bash
export IMAGE_ROUTER_IMAGE='registry.example.com/agentgateway-image-router@sha256:<digest>'
envsubst < deploy/resources.yaml | kubectl apply --dry-run=server -f -
envsubst < deploy/resources.yaml | kubectl apply -f -
kubectl apply --dry-run=server -f deploy/httproute.yaml
kubectl apply -f deploy/httproute.yaml
```

The namespace, Gateway name, Secret names, DNS selectors, and cluster egress
policy must be reviewed for each environment. The NetworkPolicy permits outbound
TCP 443 because the router connects directly to two external HTTPS upstreams.

Verify routing without generating an image by sending a valid model and omitting
`prompt`. A provider validation error proves the route and credential worked,
but does not create a generation task.

## Removing the custom service

The service can be removed only if the API contract changes to one of these
options:

1. Clients send a provider header.
2. Each provider uses a different path or hostname.
3. Only one image upstream remains.
4. The gateway gains native JSON-body model routing.
