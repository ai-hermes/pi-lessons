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

## CI

`.github/workflows/agentgateway-image-router.yml` is path-scoped. Pull requests run it only when this app or its workflow changes. Pushes to `main` use the same path filters.

The workflow:

1. installs the hashed Python dependency lock;
2. audits dependencies and runs unit tests;
3. validates deployment YAML and scans for credential-shaped values;
4. builds and smoke-tests the runtime container without external image calls;
5. builds `linux/amd64` and `linux/arm64` images;
6. pushes the tested multi-platform image to GHCR only on a matching `main` push.

Manual runs execute CI but do not publish an image.

## Deployment record

The former `deploy/resources.yaml` is split by responsibility without changing
its resource specifications. These are environment-aware templates, not a
portable one-command installer.

| File in `deploy/` | Responsibility |
| --- | --- |
| `deployment.yaml` | Router image, upstream Secret references, probes and pod security |
| `service.yaml` | Stable in-cluster address for the Router pods |
| `networkpolicy.yaml` | Gateway-only ingress, HTTPS upstream egress and DNS |
| `backend.yaml` | Connect Agentgateway to the Service, with a 190-second timeout |
| `httproute.yaml` | Send `POST /v1/images/generations` to `image-model-router` |
| `agentgateway-model-pool.yaml` | Optional NewAPI text models: two internal channels and five public virtual models |
| `agentgateway-client-auth.yaml` | Strict client authentication for chat and images; remove client credentials before forwarding |

`httproute.yaml` is also the sanitized counterpart of the local
`agentgateway-thirdparty-image.yaml`; that file defines an HTTPRoute, not a
Backend. There is no duplicate image route to apply.

Create the namespaces, Gateway and required Secrets outside Git first. Install
compatible Agentgateway CRDs, and review namespace names, Gateway references,
Secret names, DNS selectors and cluster egress rules. The NetworkPolicy permits
outbound TCP 443 because the Router connects to two external HTTPS upstreams.

From this app directory, set the image to an immutable digest. Validate **all**
selected resources before applying. Apply the client-auth policy before exposing
the image route. If a route already has an authentication policy, merge the
example into that policy rather than attach another policy to the same route:

```bash
export IMAGE_ROUTER_IMAGE='registry.example.com/agentgateway-image-router@sha256:<digest>'
envsubst '${IMAGE_ROUTER_IMAGE}' < deploy/deployment.yaml | kubectl apply --dry-run=server -f -
kubectl apply --dry-run=server \
  -f deploy/service.yaml -f deploy/networkpolicy.yaml -f deploy/backend.yaml \
  -f deploy/agentgateway-client-auth.yaml -f deploy/httproute.yaml
kubectl apply -f deploy/agentgateway-client-auth.yaml
kubectl describe agentgatewaypolicy ark-image-client-auth -n ark-gateway
# Confirm that the policy is accepted before exposing the route below.
kubectl apply -f deploy/networkpolicy.yaml -f deploy/service.yaml -f deploy/backend.yaml
envsubst '${IMAGE_ROUTER_IMAGE}' < deploy/deployment.yaml | kubectl apply -f -
kubectl apply -f deploy/httproute.yaml
```

Do not use `kubectl apply -f deploy/`: the image placeholder needs rendering and
the text models have separate prerequisites. Scripts using the old
`deploy/resources.yaml` path must switch to these individual files. Splitting
files does not delete or rename the existing Kubernetes resources.

### NewAPI text model example

Different NewAPI API keys select different groups, and each group has its own
available models. The examples use Codex and Claude groups for text, plus a
separate image-group key in `deployment.yaml`. Keep those upstream keys separate
from the gateway's client keys.

```text
client model=gpt-6-astra
  -> public virtual model gpt-6-astra
  -> target thirdparty-codex/gpt-6-astra
  -> internal channel thirdparty-codex (its own Secret)
  -> strip thirdparty-codex/
  -> NewAPI receives model=gpt-6-astra
```

The model pool contains GPT (`gpt-6-astra`, `gpt-6.1-sol`) and Claude
(`claude-fable-5.1`, `claude-opus-5.5`, `claude-sonnet-5.5`) examples. These are
deployment model IDs, not a guarantee that another account's group offers them.
Check your group's model list before adapting the file. Each virtual model has
one target; this example does not provide cross-channel failover.

The three public Claude names use dots in the version; their upstream targets
remain `claude-fable-5-1`, `claude-opus-5-5` and `claude-sonnet-5-5`. Renaming
`AgentgatewayModel.metadata.name` does not require renaming the upstream model ID.
Applying these renamed resources does not delete previously deployed Claude
resources; migrate clients before removing the old names separately.

The pool attaches to an **existing** `HTTPRoute/ark-chat` with a rule named
`models`. That chat route and Gateway are not supplied here. Keep existing
Agent Plan, Coding Plan and PAYG resources in your own configuration; this
NewAPI-only excerpt deliberately excludes private group names and endpoint IDs.
It does not replace the complete model pool. YAML anchors are defined within
this file; copy the full document or expand aliases when extracting a model.

Once the chat route and `thirdparty-codex-key` / `thirdparty-claude-key`
Secrets exist, apply the optional text example:

```bash
kubectl apply --dry-run=server -f deploy/agentgateway-model-pool.yaml
kubectl apply -f deploy/agentgateway-model-pool.yaml
```

The auth policy accepts `Authorization: Bearer <gateway-client-key>` or
`x-api-key: <gateway-client-key>`. Authorization takes precedence: an invalid
Authorization header does not fall back to `x-api-key`. Both headers are removed
after validation; upstream Model policies or Router environment variables supply
the provider credentials. The referenced `agentgateway-client-keys` Secret must
use the format supported by your installed Agentgateway version.

The auth example targets chat and images only. It intentionally does not target
an existing video route. Do not remove or overwrite a broader media policy
without preserving that route's authentication.

Images still follow `HTTPRoute -> AgentgatewayBackend -> Router`; adding the text
model pool does not turn image models into AgentgatewayModels or change their
discovery behavior.

Check that the auth policy has been accepted before applying the image route;
server-side dry-run alone does not establish that the controller enforces it.
For an existing deployment, inspect route and policy status after applying:

```bash
kubectl get httproute,agentgatewaybackend,agentgatewaypolicy -n ark-gateway
kubectl describe agentgatewaypolicy ark-image-client-auth -n ark-gateway
```

A request with a missing `prompt` is not an authentication test: an upstream may
validate the body before checking credentials. Use mocked tests for a no-cost
local routing check; any live inference probe may incur charges.

## Removing the custom service

The service can be removed only if the API contract changes to one of these
options:

1. Clients send a provider header.
2. Each provider uses a different path or hostname.
3. Only one image upstream remains.
4. The gateway gains native JSON-body model routing.
