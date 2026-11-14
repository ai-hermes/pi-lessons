#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?Usage: bash deploy/release.sh <successful-main-workflow-run-id> [--upload]}"
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "Invalid workflow run ID" >&2; exit 1; }
[[ $# -le 2 && ( "${2:-}" == "" || "${2:-}" == "--upload" ) ]] || { echo "Expected optional --upload" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(git -C "$app_root" rev-parse --show-toplevel)"
cd "$repo_root"
for tool in gh skopeo shasum python3; do command -v "$tool" >/dev/null; done
if [[ "${2:-}" == "--upload" ]]; then
  command -v bdpan >/dev/null
  bdpan info
fi
run="$(gh run view "$run_id" --repo ai-hermes/pi-lessons --json conclusion,headBranch,headSha,workflowName)"
read -r commit version < <(printf '%s' "$run" | python3 -c '
import json, sys
r = json.load(sys.stdin)
assert r["conclusion"] == "success" and r["headBranch"] == "main"
assert r["workflowName"] == "agentgateway-image-mcp CI"
print(r["headSha"], "v1.0.0-" + r["headSha"][:12])
')
test "$(git rev-parse HEAD)" = "$commit"
test -z "$(git status --porcelain -- apps/agentgateway-image-mcp .github/workflows/agentgateway-image-mcp.yml)"
archive="agentgateway-image-mcp-$version-multiarch.tar"
bundle="deploy/agentgateway-image-mcp/$version"
remote="bd://deploy/agentgateway-image-mcp/$version"
test ! -e "$bundle" || { echo "Archive directory already exists: $bundle" >&2; exit 1; }
mkdir -p "$bundle/images" "$bundle/config"
gh run download "$run_id" --repo ai-hermes/pi-lessons -n agentgateway-image-mcp-multiarch -D "$bundle/images"
(cd "$bundle/images" && shasum -a 256 -c SHA256SUMS)
test -f "$bundle/images/$archive"
platform="linux/amd64,linux/arm64"
digest="$(skopeo inspect --raw "oci-archive:$bundle/images/$archive" | python3 "$app_root/deploy/inspect_index.py")"
image="ghcr.io/ai-hermes/agentgateway-image-mcp"
test "$(cat "$bundle/images/image.txt")" = "$image@$digest"
archive_hash="$(shasum -a 256 "$bundle/images/$archive" | cut -d ' ' -f1)"
printf '# archive\timage\tplatform\tdigest\tarchive_hash\n%s\t%s\t%s\t%s\tsha256:%s\n' \
  "$archive" "$image:$version" "$platform" "$digest" "$archive_hash" > "$bundle/images.lock"
git archive --format=tar --output="$bundle/source.tar" "$commit" -- \
  apps/agentgateway-image-mcp .github/workflows/agentgateway-image-mcp.yml
cp "$app_root/deploy/resources.yaml" "$bundle/config/resources.yaml"
cp "$app_root/deploy/BUNDLE.md" "$bundle/README.md"
cp "$app_root/deploy/publish.sh" "$bundle/config/publish.sh"
cp "$app_root/deploy/inspect_index.py" "$bundle/config/inspect_index.py"
(cd "$bundle" && find . -type f ! -path ./SHA256SUMS | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "${file#./}"; done > SHA256SUMS)
(cd "$bundle" && shasum -a 256 -c SHA256SUMS)
echo "Verified reproducibility archive: $bundle"
if [[ "${2:-}" == "--upload" ]]; then
  if bdpan ls "$remote/"; then
    echo "Remote version already exists; refusing to overwrite it." >&2
    exit 1
  fi
  bdpan cp "$bundle/" "$remote/" --recursive --dryrun --no-overwrite
  bdpan cp "$bundle/" "$remote/" --recursive --no-overwrite
  bdpan ls "$remote/"
fi
echo "Archiving does not upload to a business registry or deploy to Kubernetes."
