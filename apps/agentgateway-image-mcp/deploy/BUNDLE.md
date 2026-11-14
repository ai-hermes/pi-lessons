# Optional reproducibility archive

The archive preserves a tested `linux/amd64` + `linux/arm64` image and its source.
Netdisk upload is recommended for long-term retention, but neither archiving nor
Netdisk is required to use the image from GHCR. No deployment is performed.

## Create and optionally upload

Use the exact clean commit of a successful main CI run. Install `gh`, `skopeo`,
Python 3, Bash, and `shasum`; authenticate `gh`. Add `bdpan` only for upload.

```bash
bash apps/agentgateway-image-mcp/deploy/release.sh <workflow-run-id> --upload
```

Omit `--upload` to create only the local archive. Choose one invocation; existing
local or remote version directories are not overwritten. The local path is
`deploy/agentgateway-image-mcp/<version>/`; the remote path, if uploaded, is
`bd://deploy/agentgateway-image-mcp/<version>/`.

Contents:

```text
<version>/
├── README.md
├── SHA256SUMS
├── images.lock
├── source.tar                 # exact application source and CI workflow
├── images/
│   ├── agentgateway-image-mcp-<version>-multiarch.tar
│   ├── image.txt              # immutable GHCR image reference
│   └── SHA256SUMS
└── config/
    ├── resources.yaml         # author's environment template
    ├── publish.sh             # author's optional VKE procedure
    └── inspect_index.py
```

The outer checksums cover the files above, including the inner checksums.
`images.lock` records the archive filename, GHCR tag, platforms, index digest, and
archive hash. It is not a global mutable manifest. Secrets and kubeconfig are
not included; archived manifests still need the environment's external
dependencies. Reproducing the deployed image means retaining these bytes, not
assuming a future rebuild will produce an identical digest.

## Download and verify when needed

Download the selected version directory from Netdisk only when restoring or
moving the archive to another machine. Then run:

```bash
cd <archive-directory>
shasum -a 256 -c SHA256SUMS
digest="$(skopeo inspect --raw "oci-archive:images/agentgateway-image-mcp-<version>-multiarch.tar" |
  python3 config/inspect_index.py)"
test "$(cat images/image.txt)" = "ghcr.io/ai-hermes/agentgateway-image-mcp@$digest"
```

Stop on a checksum or digest mismatch. Download-back is not a routine publishing
step. An independent restore/check is useful for important archived versions.

## Restore the archived image

If GHCR is unavailable, copy the verified archive to a chosen registry:

```bash
skopeo login <destination-registry>
skopeo copy --all --preserve-digests \
  'oci-archive:images/agentgateway-image-mcp-<version>-multiarch.tar' \
  'docker://<destination-registry>/<repository>:<version>'
test "$(skopeo inspect --raw 'docker://<destination-registry>/<repository>:<version>' |
  python3 config/inspect_index.py)" = "$digest"
```

Use a new version tag; do not overwrite an existing tag with different content.
Keep both architectures and deploy by the verified digest.

## Deployment is separate and environment-specific

Normally use GHCR directly, without downloading this archive. The repository's
README records the author's optional GHCR → business registry → VKE procedure.
The archived `config/publish.sh` takes a source registry image, not this directory:

```bash
export KUBECONFIG='<your-reviewed-kubeconfig>'
export REGISTRY_USERNAME='<destination-registry-username>'
export REGISTRY_IMAGE='<destination-registry>/<repository>:<version>'
bash config/publish.sh "$(cat images/image.txt)"
```

Only run that script after reviewing `config/resources.yaml` for the target
cluster. Its namespace, Secret names, gateway references, DNS, and networking
match the author's environment. A failed rollout restores an existing
Deployment only; other resource changes require separate review. Failed first
deployments retain their resources. Never delete shared gateways or credentials
as part of rollback.
