# Image MCP offline bundle

## Prerequisites

Supported platforms: `linux/amd64` and `linux/arm64`. Install `bdpan`, `skopeo`, `kubectl`,
GNU `envsubst`, Python 3, Bash, and `shasum`. An existing Agentgateway installation,
the `ark-gateway` namespace, its registry pull secret, client-key secret, and
independent MCP upstream-auth secret are required. Secrets are not included.
The `charts/` directory is intentionally empty: deployment uses raw manifests.
The stateless MCP service uses default Kubernetes scheduling, with no fixed node
list or custom node labels. Both architectures share one image index; nodes pull
the matching image.

## Download and verify

Set `REMOTE_ROOT` to `bd://deploy/agentgateway-image-mcp/<version>`.
Download `README.md`, `SHA256SUMS`, and `images.lock` first.
Download only the archive named in `images.lock` from this package's `images/`
directory, plus `config/resources.yaml`, `config/publish.sh`, `config/inspect_index.py`, and
`charts/.gitkeep`, preserving relative paths. Use `bdpan cp --dryrun`
before the image transfer. Then run:

```bash
cd <bundle-directory>
shasum -a 256 -c SHA256SUMS
```

Do not load or publish an archive with a checksum mismatch. Discard only the
corrupt downloaded file and retry once; do not overwrite remote artifacts.

## Install

```bash
export KUBECONFIG='<kubeconfig-path>'
export REGISTRY_USERNAME='<robot-username>'
bash config/publish.sh .
```

Enter the registry password through stdin. The script validates the lock,
checks the manifest with the Kubernetes API, copies the downloaded image with
local skopeo's `oci-archive:` transport with `--all --preserve-digests`, verifies
both platforms and the registry index digest, and rolls out the image pinned to
that index digest.
The registry location comes from `images.lock`. A different existing image tag
is never overwritten. A failed rollout restores the previous Deployment.
Existing Secrets and the previous source ConfigMap are retained.

## Verify

```bash
kubectl -n ark-gateway rollout status deployment/ark-image-mcp
kubectl -n ark-gateway get pods -l app=ark-image-mcp
```

The endpoint remains `/mcp/images` on the existing public gateway.
Use the repository's `check.mjs` with `AGENTGATEWAY_MCP_URL` configured to
test public authentication, tool listing, and invalid arguments without
generating billable images. NetworkPolicy is defense in depth, not a
replacement for application authentication.

## Rollback and cleanup

```bash
kubectl -n ark-gateway rollout undo deployment/ark-image-mcp
kubectl -n ark-gateway rollout status deployment/ark-image-mcp
```

After a manual rollback, reapply the previous version's rendered manifest
before releasing again, so client-side apply tracking matches the old template.
The deployment script's automatic rollback restores both from a local snapshot.

After confirming the service is no longer needed, render the resource template
with the same variables and use `kubectl delete -f <rendered-resource-file>`.
Do not delete shared gateway resources, client keys, or registry credentials.
