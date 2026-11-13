#!/usr/bin/env bash
set -euo pipefail

: "${KUBECONFIG:?Set the VKE kubeconfig}"
: "${REGISTRY_USERNAME:?Set the registry robot username}"
: "${MCP_NODE_1:?Set the first eligible node hostname}"
: "${MCP_NODE_2:?Set the second eligible node hostname}"
: "${MCP_NODE_3:?Set the third eligible node hostname}"
bundle="$(cd "${1:?Usage: bash publish.sh <verified-bundle-directory>}" && pwd)"
for tool in skopeo kubectl envsubst shasum; do command -v "$tool" >/dev/null; done
(cd "$bundle" && shasum -a 256 -c SHA256SUMS)
test "$(awk '!/^#/ { n++ } END { print n }' "$bundle/images.lock")" = 1
IFS=$'\t' read -r archive image platform digest archive_hash < <(awk '!/^#/' "$bundle/images.lock")
[[ "$archive" != */* && "$archive" != *..* && "$archive" == *.tar ]]
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
test "$platform" = "linux/amd64"
test "$(skopeo inspect "docker-archive:$bundle/images/$archive" --format '{{.Digest}}')" = "$digest"
test "$(skopeo inspect "docker-archive:$bundle/images/$archive" --format '{{.Os}}/{{.Architecture}}')" = "$platform"
temp_dir="$(mktemp -d)"
trap 'rm -f "$temp_dir/auth.json" "$temp_dir/resources.yaml"; rmdir "$temp_dir"' EXIT
export MCP_IMAGE="${image%:*}@$digest"
envsubst '${MCP_IMAGE} ${MCP_NODE_1} ${MCP_NODE_2} ${MCP_NODE_3}' < "$bundle/config/resources.yaml" > "$temp_dir/resources.yaml"
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
if existing="$(skopeo inspect --authfile "$temp_dir/auth.json" "docker://$image" --format '{{.Digest}}' 2>/dev/null)"; then
  test "$existing" = "$digest" || { echo "Refusing to overwrite a different image tag" >&2; exit 1; }
else
  skopeo copy --authfile "$temp_dir/auth.json" --preserve-digests \
    "docker-archive:$bundle/images/$archive" "docker://$image"
fi
test "$(skopeo inspect --authfile "$temp_dir/auth.json" "docker://$image" --format '{{.Digest}}')" = "$digest"
kubectl apply -f "$temp_dir/resources.yaml"
if ! kubectl -n ark-gateway rollout status deployment/ark-image-mcp --timeout=180s; then
  kubectl -n ark-gateway rollout undo deployment/ark-image-mcp
  kubectl -n ark-gateway rollout status deployment/ark-image-mcp --timeout=180s
  exit 1
fi
kubectl -n ark-gateway get pods -l app=ark-image-mcp -o wide
echo "Published and deployed $MCP_IMAGE"
