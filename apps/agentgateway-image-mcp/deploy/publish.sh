#!/usr/bin/env bash
set -euo pipefail

# This is the author's VKE procedure, not a portable Kubernetes installer.
: "${KUBECONFIG:?Set the VKE kubeconfig}"
: "${REGISTRY_USERNAME:?Set the registry robot username}"
: "${REGISTRY_IMAGE:?Set the destination image including its version tag}"
source="${1:?Usage: bash publish.sh <source-registry-image>}"
image="$REGISTRY_IMAGE"
[[ "$source" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+(:[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$ ]] || { echo "Invalid source image" >&2; exit 1; }
[[ "$image" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+:[a-zA-Z0-9_.-]+$ ]] || { echo "Destination image needs a version tag" >&2; exit 1; }
config="$(cd "$(dirname "$0")" && pwd)"
for tool in skopeo kubectl envsubst python3; do command -v "$tool" >/dev/null; done
digest="$(skopeo inspect --raw "docker://$source" | python3 "$config/inspect_index.py")"
source="${source%%@*}"
source="${source%:*}@$digest"
temp_dir="$(mktemp -d)"
trap 'rm -f "$temp_dir/auth.json" "$temp_dir/resources.yaml" "$temp_dir/previous-deployment.json" "$temp_dir/registry-index.json"; rmdir "$temp_dir"' EXIT
export MCP_IMAGE="${image%:*}@$digest"
envsubst '${MCP_IMAGE}' < "$config/resources.yaml" > "$temp_dir/resources.yaml"
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
  existing="$(python3 "$config/inspect_index.py" < "$temp_dir/registry-index.json")"
  test "$existing" = "$digest" || { echo "Refusing to overwrite a different image tag" >&2; exit 1; }
else
  skopeo copy --all --dest-authfile "$temp_dir/auth.json" --preserve-digests \
    "docker://$source" "docker://$image"
fi
test "$(skopeo inspect --authfile "$temp_dir/auth.json" --raw "docker://$image" | python3 "$config/inspect_index.py")" = "$digest"
kubectl -n ark-gateway get deployment ark-image-mcp --ignore-not-found -o json > "$temp_dir/previous-deployment.json"
if test -s "$temp_dir/previous-deployment.json"; then
  python3 -c '
import json, sys
d = json.load(sys.stdin)
for key in ("resourceVersion", "uid", "generation", "creationTimestamp", "managedFields"):
    d["metadata"].pop(key, None)
d.pop("status", None)
d["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
print(json.dumps(d))
' < "$temp_dir/previous-deployment.json" > "$temp_dir/registry-index.json"
  mv "$temp_dir/registry-index.json" "$temp_dir/previous-deployment.json"
fi
kubectl apply -f "$temp_dir/resources.yaml"
if ! kubectl -n ark-gateway rollout status deployment/ark-image-mcp --timeout=180s; then
  if test -s "$temp_dir/previous-deployment.json"; then
    # Restore only the Deployment; Service, route, and policies need separate review.
    kubectl apply -f "$temp_dir/previous-deployment.json"
    kubectl -n ark-gateway rollout status deployment/ark-image-mcp --timeout=180s
  else
    echo "Initial deployment failed; resources are retained for inspection." >&2
  fi
  exit 1
fi
kubectl -n ark-gateway get pods -l app=ark-image-mcp -o wide
echo "Published and deployed $MCP_IMAGE"
