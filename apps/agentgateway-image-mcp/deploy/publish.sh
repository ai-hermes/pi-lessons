#!/usr/bin/env bash
set -euo pipefail

: "${KUBECONFIG:?Set the VKE kubeconfig}"
: "${REGISTRY_USERNAME:?Set the registry robot username}"
bundle="$(cd "${1:?Usage: bash publish.sh <verified-bundle-directory>}" && pwd)"
for tool in skopeo kubectl envsubst shasum python3; do command -v "$tool" >/dev/null; done
(cd "$bundle" && shasum -a 256 -c SHA256SUMS)
test "$(awk '!/^#/ { n++ } END { print n }' "$bundle/images.lock")" = 1
IFS=$'\t' read -r archive image platform digest archive_hash < <(awk '!/^#/' "$bundle/images.lock")
[[ "$archive" != */* && "$archive" != *..* && "$archive" == *.tar ]]
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
test "$platform" = "linux/amd64,linux/arm64"
test "$(skopeo inspect --raw "oci-archive:$bundle/images/$archive" | python3 "$bundle/config/inspect_index.py")" = "$digest"
temp_dir="$(mktemp -d)"
trap 'rm -f "$temp_dir/auth.json" "$temp_dir/resources.yaml" "$temp_dir/previous-deployment.json" "$temp_dir/registry-index.json"; rmdir "$temp_dir"' EXIT
export MCP_IMAGE="${image%:*}@$digest"
envsubst '${MCP_IMAGE}' < "$bundle/config/resources.yaml" > "$temp_dir/resources.yaml"
kubectl apply --dry-run=server -f "$temp_dir/resources.yaml"
printf 'Registry password (stdin, never persisted in the repository): ' >&2
if test -t 0; then
  IFS= read -rs password
  printf '\n' >&2
  printf '%s' "$password" | skopeo login --authfile "$temp_dir/auth.json" --username "$REGISTRY_USERNAME" --password-stdin "${image%%/*}"
  unset password
else
  skopeo login --authfile "$temp_dir/auth.json" --username "$REGISTRY_USERNAME" --password-stdin "${image%%/*}"
fi
if skopeo inspect --authfile "$temp_dir/auth.json" --raw "docker://$image" > "$temp_dir/registry-index.json" 2>/dev/null; then
  existing="$(python3 "$bundle/config/inspect_index.py" < "$temp_dir/registry-index.json")"
  test "$existing" = "$digest" || { echo "Refusing to overwrite a different image tag" >&2; exit 1; }
else
  skopeo copy --all --authfile "$temp_dir/auth.json" --preserve-digests \
    "oci-archive:$bundle/images/$archive" "docker://$image"
fi
test "$(skopeo inspect --authfile "$temp_dir/auth.json" --raw "docker://$image" | python3 "$bundle/config/inspect_index.py")" = "$digest"
kubectl -n ark-gateway get deployment ark-image-mcp -o json | python3 -c '
import json, sys
d = json.load(sys.stdin)
for key in ("resourceVersion", "uid", "generation", "creationTimestamp", "managedFields"):
    d["metadata"].pop(key, None)
d.pop("status", None)
d["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
print(json.dumps(d))
' > "$temp_dir/previous-deployment.json"
kubectl apply -f "$temp_dir/resources.yaml"
if ! kubectl -n ark-gateway rollout status deployment/ark-image-mcp --timeout=180s; then
  # Reapply the snapshot so client-side apply tracking is restored with the pod template.
  kubectl apply -f "$temp_dir/previous-deployment.json"
  kubectl -n ark-gateway rollout status deployment/ark-image-mcp --timeout=180s
  exit 1
fi
kubectl -n ark-gateway get pods -l app=ark-image-mcp -o wide
echo "Published and deployed $MCP_IMAGE"
