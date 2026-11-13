# Agentgateway image MCP

Standalone Streamable HTTP MCP server exposing `generate_image`. It reuses
the existing gateway's Ark image API, model aliases, authentication, and
billing controls. The public route is `/mcp/images`; no second domain is needed.
It returns image URLs, never retries a possibly billed request, and requires
independent backend authentication even when NetworkPolicy is not enforced.

## Development

```bash
cd apps/agentgateway-image-mcp
uv venv --python 3.12
uv pip sync --require-hashes requirements.txt
.venv/bin/python -m unittest -v
npm ci --ignore-scripts
npm test
```

The Python dependencies and base image are pinned; SDK and HTTP transport
versions include known security fixes. The local bridge owns its SDK instead of importing
from an unrelated plugin cache. Refresh locks deliberately, with compatibility
and security testing.

## CI/CD

The `agentgateway-image-mcp CI` workflow runs on relevant PRs, main pushes,
and manual dispatch. It audits dependencies, tests the bridge, builds a dedicated `linux/amd64`
image, runs Python tests both during build and as the runtime user, and checks
read-only startup and unauthorized HTTP access. Main/manual runs publish a
OCI-compatible Docker export with SHA-256 metadata as a GitHub Actions artifact.
Both packaging and publishing use skopeo's `oci-archive:` transport to preserve
the exported compressed-layer manifest digest.

The deployment stage deliberately runs locally: no Netdisk, registry, or
VKE credentials are uploaded to GitHub. Run it from the exact clean commit
used by a successful main workflow:

```bash
export REGISTRY_IMAGE='<registry>/<namespace>/agentgateway-image-mcp'
bash apps/agentgateway-image-mcp/deploy/release.sh <workflow-run-id>
```

This stores archives under root `deploy/images/`, maintains the global TSV
index with a remote backup, creates an immutable self-contained package at
`bd://deploy/agentgateway-image-mcp/<version>/`, uploads using `bdpan`, and
downloads the selected package again for checksum validation.
Large archives and generated packages are Git-ignored.

Then follow [the bundle instructions](deploy/BUNDLE.md) to copy the downloaded
archive into the VKE registry using local skopeo and roll out the image by
digest. Existing Secrets, Service, routing, gateway policies, and eligibility
of the three configured nodes remain unchanged. On rollout failure, the
deployment script restores the previous Deployment.

## Local Codex configuration

Install the Node dependency with `npm ci --ignore-scripts`. Store the existing
gateway client key in macOS Keychain under service `agentgateway-api-aii`,
with the current username as its account. Do not put the key in TOML.

```toml
[mcp_servers.agentgateway_images]
command = "<absolute-node-path>"
args = ["<repository-path>/apps/agentgateway-image-mcp/local-bridge.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 210

[mcp_servers.agentgateway_images.env]
AGENTGATEWAY_MCP_URL = "https://<gateway-domain>/mcp/images"
```

Restart the client to load changed MCP configuration. Verify without billing:

```bash
export AGENTGATEWAY_MCP_URL='https://<gateway-domain>/mcp/images'
npm --prefix apps/agentgateway-image-mcp run check
```

The check covers missing/invalid authentication, public and stdio tool listing,
invalid tool arguments, and existing gateway routes. It omits the image prompt
when probing the media API, so no real image is generated.
