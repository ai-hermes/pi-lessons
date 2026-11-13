# Agentgateway image MCP

Standalone Streamable HTTP MCP server exposing `generate_image`. It reuses
the existing gateway's Ark image API, model aliases, authentication, and
billing controls. The public route is `/mcp/images`; no second domain is needed.
The MCP route accepts only `Authorization: Bearer <key>`, not `x-api-key`;
the existing image API's authentication is unchanged.
The default model is `doubao-seedream-5.0-flash`; pass
`model="doubao-seedream-5.0-pro"` explicitly when requesting Pro.
It returns image URLs, never retries a possibly billed request, and requires
independent backend authentication even when NetworkPolicy is not enforced.
Seedream 5.0 pro/flash omit the unsupported `sequential_image_generation`
parameter; 5.0 lite, 4.5, and 4.0 explicitly set it to `disabled`.

## Development

```bash
cd apps/agentgateway-image-mcp
uv venv --python 3.12
uv pip sync --require-hashes requirements.txt
.venv/bin/python -m unittest -v
npm ci --ignore-scripts
npm test
```

The Python dependencies and base image are pinned. The HTTP verification client
uses its own locked SDK dependency. Refresh locks deliberately, with compatibility
and security testing. `npm test` checks script syntax and verifies that plaintext
endpoints and missing credentials are rejected before any network request. It
also checks the MCP policy, default scheduling, multi-architecture index
validation, and OCI archive copying (when skopeo is installed).

## CI/CD

The `agentgateway-image-mcp CI` workflow runs on relevant PRs, main pushes,
and manual dispatch. It audits dependencies, checks the HTTP verification client,
and uses Buildx with QEMU to build `linux/amd64` and `linux/arm64` images. Both
architectures run Python tests during build and as the runtime user, plus
read-only startup and unauthorized HTTP access checks. Main/manual runs upload
one OCI archive with SHA-256 metadata as `agentgateway-image-mcp-multiarch`.
Packaging validates both platforms. Publishing uses skopeo's `oci-archive:`
transport with `--all --preserve-digests` to retain the complete image index.

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
index digest, so amd64 and arm64 nodes pull the matching image. No fixed node
list or custom node labels are required. Existing Secrets, Service, routing,
and gateway policies remain in place. On rollout failure, the
deployment script restores the previous Deployment.

## Local Codex configuration

Codex connects directly to the public Streamable HTTP endpoint; no local MCP
process or Node dependency is needed for normal use. Its process must inherit
`AGENTGATEWAY_API_KEY`. Do not put the key in TOML.

```toml
[mcp_servers.agentgateway_images]
url = "https://<gateway-domain>/mcp/images"
bearer_token_env_var = "AGENTGATEWAY_API_KEY"
startup_timeout_sec = 30
tool_timeout_sec = 210
```

On macOS, the existing key can stay in Keychain under service
`agentgateway-api-aii`, with the current username as its account. Load it before
starting the CLI:

```bash
export AGENTGATEWAY_API_KEY="$(/usr/bin/security find-generic-password -w -a "$(id -un)" -s agentgateway-api-aii)"
codex
```

For a desktop client, set its launch environment before fully quitting and
reopening the app:

```bash
launchctl setenv AGENTGATEWAY_API_KEY "$AGENTGATEWAY_API_KEY"
```

The launch environment lasts only for the current macOS login session; repeat
after logout or reboot. Environment variables are inherited by child processes,
so keep this key out of logs and untrusted processes.

Restart the client to load changed MCP configuration. Node dependencies are
only needed for the verification script. Verify without billing:

```bash
export AGENTGATEWAY_MCP_URL='https://<gateway-domain>/mcp/images'
npm --prefix apps/agentgateway-image-mcp ci --ignore-scripts
npm --prefix apps/agentgateway-image-mcp run check
```

The check covers missing/invalid Bearer authentication, rejection of `x-api-key`-only requests, public HTTP tool listing,
invalid tool arguments, and existing gateway routes. It omits the image prompt
when probing the media API, so no real image is generated.
