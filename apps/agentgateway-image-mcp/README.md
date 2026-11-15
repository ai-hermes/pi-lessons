# Agentgateway image MCP

Standalone Streamable HTTP MCP server exposing `generate_image`. It reuses
the existing gateway's image API, model aliases, authentication, and
billing controls. The public route is `/mcp/images`; no second domain is needed.
The MCP route accepts only `Authorization: Bearer <key>`, not `x-api-key`;
the existing image API's authentication is unchanged.
The default model is `doubao-seedream-5.0-flash`; pass
`model="doubao-seedream-5.0-pro"` explicitly when requesting Pro.
It normalizes both URL and native Base64 results to a standard MCP image block.
Successful previews contain only one Base64 `ImageContent`, not URL text,
API JSON, or `structuredContent`. Original URLs are a failure/overflow fallback.
It never retries a possibly billed request and requires
independent backend authentication even when NetworkPolicy is not enforced.
Seedream 5.0 pro/flash omit the unsupported `sequential_image_generation`
parameter; 5.0 lite, 4.5, and 4.0 explicitly set it to `disabled`.

## GPT Image 2

Pass `model="gpt-image-2"` to use the cluster's existing Haoduotoken channel.
Both models use `POST /v1/images/generations` without `x-image-provider`.
The cluster's `image-model-router` backend forwards requests to
`agentgateway-image-router:8000`, which selects Haoduotoken for `gpt-image-2`
and Ark for `doubao-seedream-*` from the JSON `model` field.
The gateway's credentials and billing are unchanged.
The default model remains Seedream Flash.

GPT requests send `n=1` and omit Ark's `watermark`,
`sequential_image_generation`, and `response_format` parameters.
`watermark` has no effect on GPT Image 2. PNG and JPEG output are supported.
For GPT, `1K` maps to `1024x1024`, `2K` to `2560x1440`, and `4K` to
`3840x2160`; these shorthand sizes do not all have the same aspect ratio.
Use explicit dimensions (for example `1536x1024`) to choose the aspect ratio,
or `auto` for automatic sizing (GPT only). Explicit GPT dimensions must be
multiples of 16, neither edge may exceed 3840 pixels, the aspect ratio must
not exceed 3:1, and total pixels must be between 655,360 and 8,294,400.
Sizes above `2560x1440` are experimental upstream.

Native GPT `b64_json` is validated and returned unchanged in a standard MCP
image block, without downloading, resizing, or transcoding. Its MIME is checked
against PNG/JPEG signatures. URL results use the same safe download path as
Seedream. The adapter does not send GPT's unsupported `response_format` parameter.
If an image cannot be returned, any original URL(s) are the fallback.
If the upstream returned only Base64 and no URL, an unavailable/oversized preview
instead produces a notice. It does not retry, fabricate a URL, upload the image
elsewhere, or mark generation as failed.

Example tool arguments:

```json
{"prompt": "A peaceful blue sky with soft white clouds", "model": "gpt-image-2", "size": "1536x1024", "output_format": "png"}
```

## Unified Base64 image results

Only the first image is inlined. URL results are downloaded and Base64 encoded;
native `b64_json` results are validated and used directly. Both become the same
standalone `ImageContent` block. Images are not resized or transcoded.

`MCP_IMAGE_ALLOWED_HOSTS` is a comma-separated exact hostname allowlist,
confirmed from existing image results. The default is empty (no downloads);
no suffix matching, wildcards, or automatic trust of returned URLs.
Downloads require HTTPS on port 443 without URL credentials, use a separate
client with no authentication headers or environment proxies, and do not
follow redirects. A five-second total deadline, streaming 10 MiB inclusive
size limit, and PNG/JPEG MIME/signature checks apply. Encoded downloads
are rejected. Native Base64 is strictly decoded and subject to the same
10 MiB raw image cap and PNG/JPEG signature checks.

The image HTTPRoute's request buffer budget is `10Mi`. Agentgateway v1.7.0
propagates that budget to the MCP upstream response parser; setting only an
outgoing response-buffer policy would not fix upstream parsing. Other routes
keep their existing budgets. This is a bounded memory budget, not a preallocated
buffer; concurrent large responses can still multiply gateway memory use.

The server checks the full UTF-8 serialized JSON-RPC image response, including
the actual request ID, against 10 MiB (inclusive). Base64 expands the image by
approximately one third, so a raw image below 10 MiB may still exceed the full
response budget. Failures and overflow return only original URL(s), one per line,
or a notice if no URL is available. An oversized URL fallback also becomes a
short notice. Generation is never retried after a successful upstream call.
A standard image block does not guarantee terminal pixel rendering in Codex
or Pi; actual TUI display must be verified separately.

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
Python tests use mocked generation/download requests and in-process ASGI protocol
checks, including authentication, tool discovery, unified Base64 image blocks,
safe downloads, MIME/signatures, no-URL notices, and serialized response budgets.
They do not start a local service or make billed image-generation calls.

## Image build and GHCR

The `agentgateway-image-mcp CI` workflow runs on relevant PRs, main pushes,
and manual dispatch. It audits dependencies, checks the HTTP verification client,
and uses Buildx with QEMU to build `linux/amd64` and `linux/arm64` images. Both
architectures run Python tests during build and as the runtime user, plus
read-only startup and unauthorized HTTP access checks. Successful main runs
(including manual runs on main) push the tested image to:

```text
ghcr.io/ai-hermes/agentgateway-image-mcp:v1.0.0-<commit-sha12>
```

The workflow uses `GITHUB_TOKEN` with `packages: write`, links the image to this
repository, and reports its immutable index digest in the run summary. It refuses
to replace a version tag with different image content. PRs and non-main manual
runs only build and test; they do not publish. Existing GHCR package permissions
must allow this repository to write. Package visibility is configured in GitHub,
not changed by the workflow; private pulls need GHCR credentials.

The same OCI archive, pinned `image.txt`, and SHA-256 checksums are retained for
30 days as the `agentgateway-image-mcp-multiarch` GitHub artifact. CI stops here:
it does not upload to Netdisk or a business registry, or access Kubernetes.

## Optional reproducibility archive

Archiving is recommended to retain the exact image, source, workflow, and
environment-specific configuration beyond GitHub artifact retention. It is not a
deployment prerequisite. From the clean commit used by a successful main run:

```bash
bash apps/agentgateway-image-mcp/deploy/release.sh <workflow-run-id>
# Add --upload to also archive this version on Netdisk:
bash apps/agentgateway-image-mcp/deploy/release.sh <workflow-run-id> --upload
```

Choose one command; the script refuses to overwrite an existing local version.
It creates and verifies `deploy/agentgateway-image-mcp/<version>/`. `--upload`
also copies it to `bd://deploy/agentgateway-image-mcp/<version>/` without replacing
remote files. No global mutable index, duplicate image upload, or automatic
download-back is involved. `bdpan` is needed only with `--upload`. Archives are
Git-ignored. See [archive contents and restoration](deploy/BUNDLE.md).

## Optional deployment: author's VKE environment

`deploy/resources.yaml` and `deploy/publish.sh` record the author's environment,
not a portable installer. They use namespace `ark-gateway`, the existing
Agentgateway, internal DNS, Secret names, and NetworkPolicy selectors. Review
and adapt these before using another cluster. Building or archiving an image
does not require deploying it.

For this environment, copy the GHCR image directly to the business registry and
then apply the local resource template:

The running deployment currently uses the temporary
`ark-image-mcp-preview-code` ConfigMap mounted read-only at `/mcp/server.py`,
so its code differs from the container image. This mount is not part of the
permanent resource template. Keep it until an image containing the same code
is deployed; then remove the `preview-code` mount/volume and code-hash annotation,
restore `maxSurge`/`maxUnavailable` to their original `25%` values, wait for
rollout, and delete the temporary ConfigMap. Retain the confirmed
`MCP_IMAGE_ALLOWED_HOSTS` configuration for image downloads in the formal release.

```bash
export KUBECONFIG=/Users/aholic/.kube/aiinsight-boe.conf
export REGISTRY_USERNAME='crrobot@ai-insight'
export REGISTRY_IMAGE='ai-insight-cr-cn-beijing.cr.volces.com/container/agentgateway-image-mcp:v1.0.0-<commit-sha12>'
bash apps/agentgateway-image-mcp/deploy/publish.sh \
  'ghcr.io/ai-hermes/agentgateway-image-mcp:v1.0.0-<commit-sha12>'
```

Install `skopeo`, `kubectl`, GNU `envsubst`, Bash, and Python 3. Authenticate to
GHCR with `skopeo login ghcr.io` first if the package is private; the business
registry password is entered through stdin and stored only in temporary auth
configuration. No personal registry, Netdisk, or Kubernetes credentials go to CI.

The script resolves the source to a digest, validates both platforms, copies
registry-to-registry with `--all --preserve-digests`, refuses conflicting
destination tags, and deploys the verified destination digest. It performs a
server-side dry-run and waits for rollout. No fixed node list or labels are used.
For an existing Deployment, rollout failure restores its snapshot only; it does
not restore Service, NetworkPolicy, Backend, HTTPRoute, or policy changes. A
failed first deployment retains resources for inspection rather than deleting
them. Clusters that can pull GHCR directly can use its pinned image without this
business-registry copy, after adapting their resource configuration.

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
