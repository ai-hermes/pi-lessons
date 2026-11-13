#!/usr/bin/env bash
set -euo pipefail

: "${REGISTRY_IMAGE:?Set the destination repository without a tag}"
[[ "$REGISTRY_IMAGE" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+$ ]] || { echo "Invalid destination repository" >&2; exit 1; }
run_id="${1:?Usage: bash deploy/release.sh <successful-main-workflow-run-id>}"
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "Invalid workflow run ID" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(git -C "$app_root" rev-parse --show-toplevel)"
cd "$repo_root"
for tool in gh bdpan skopeo shasum; do command -v "$tool" >/dev/null; done
bdpan info
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
archive="agentgateway-image-mcp-$version-amd64.tar"
bundle="deploy/agentgateway-image-mcp/$version"
incoming="deploy/.incoming/$run_id"
download="deploy/.download/$version"
remote="bd://deploy/agentgateway-image-mcp/$version"
bdpan ls bd://deploy/images/
if bdpan ls "$remote/"; then
  echo "The version already exists; use publish.sh to resume instead of replacing it." >&2
  exit 1
fi
mkdir -p "$incoming" deploy/images "$bundle/images" "$bundle/config" "$bundle/charts"
gh run download "$run_id" --repo ai-hermes/pi-lessons -n agentgateway-image-mcp-amd64 -D "$incoming"
(cd "$incoming" && shasum -a 256 -c SHA256SUMS)
test -f "$incoming/$archive"
test ! -e "deploy/images/$archive"
mv "$incoming/$archive" "deploy/images/$archive"
platform="$(skopeo inspect --override-os linux --override-arch amd64 "oci-archive:deploy/images/$archive" --format '{{.Os}}/{{.Architecture}}')"
test "$platform" = "linux/amd64"
digest="$(skopeo inspect --override-os linux --override-arch amd64 "oci-archive:deploy/images/$archive" --format '{{.Digest}}')"
archive_hash="$(shasum -a 256 "deploy/images/$archive" | cut -d ' ' -f1)"
bdpan cp bd://deploy/images/images.manifest.tsv "$incoming/images.manifest.before.tsv" --no-overwrite
test ! -e deploy/images/images.manifest.tsv || cmp deploy/images/images.manifest.tsv "$incoming/images.manifest.before.tsv"
cp "$incoming/images.manifest.before.tsv" deploy/images/images.manifest.tsv
! awk -F '\t' -v ref="$REGISTRY_IMAGE:$version" '$2 == ref { found=1 } END { exit !found }' deploy/images/images.manifest.tsv
printf '%s\t%s\t%s\t%s\tsha256:%s\n' "$archive" "$REGISTRY_IMAGE:$version" "$platform" "$digest" "$archive_hash" >> deploy/images/images.manifest.tsv
head -n 1 deploy/images/images.manifest.tsv > "$bundle/images.lock"
tail -n 1 deploy/images/images.manifest.tsv >> "$bundle/images.lock"
cp "deploy/images/$archive" "$bundle/images/$archive"
cp "$app_root/deploy/resources.yaml" "$bundle/config/resources.yaml"
cp "$app_root/deploy/BUNDLE.md" "$bundle/README.md"
cp "$app_root/deploy/publish.sh" "$bundle/config/publish.sh"
touch "$bundle/charts/.gitkeep"
(cd "$bundle" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "${file#./}"; done > SHA256SUMS)
bdpan cp "deploy/images/$archive" "bd://deploy/images/$archive" --dryrun --no-overwrite
bdpan cp "$bundle/" "$remote/" --recursive --dryrun --no-overwrite
bdpan cp "deploy/images/$archive" "bd://deploy/images/$archive" --no-overwrite
bdpan cp "$bundle/" "$remote/" --recursive --no-overwrite
# Only the mutable index is replaced; preserve its previous content first.
bdpan cp "$incoming/images.manifest.before.tsv" "bd://deploy/images/images.manifest-before-image-mcp-$version.tsv" --dryrun --no-overwrite
bdpan cp "$incoming/images.manifest.before.tsv" "bd://deploy/images/images.manifest-before-image-mcp-$version.tsv" --no-overwrite
bdpan cp deploy/images/images.manifest.tsv bd://deploy/images/images.manifest.tsv --dryrun
bdpan cp deploy/images/images.manifest.tsv bd://deploy/images/images.manifest.tsv
bdpan ls "$remote/"
mkdir -p "$download/images" "$download/config" "$download/charts"
for file in README.md SHA256SUMS images.lock config/resources.yaml config/publish.sh charts/.gitkeep; do
  bdpan cp "$remote/$file" "$download/$file" --no-overwrite
done
cmp "$bundle/images.lock" "$download/images.lock"
# Select downloads from the project lock, not the mutable global index.
while IFS=$'\t' read -r file _; do
  [[ "$file" == \#* ]] && continue
  [[ "$file" == "$archive" ]] || { echo "Unexpected archive in project lock" >&2; exit 1; }
  bdpan cp "$remote/images/$file" "$download/images/$file" --dryrun --no-overwrite
  bdpan cp "$remote/images/$file" "$download/images/$file" --no-overwrite
done < "$download/images.lock"
(cd "$download" && shasum -a 256 -c SHA256SUMS)
echo "Verified offline bundle: $download"
echo "Next: bash $download/config/publish.sh $download"
