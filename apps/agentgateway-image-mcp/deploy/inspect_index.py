"""Validate a raw two-platform image index from skopeo and print its digest."""

import hashlib
import json
import re
import sys


def index_digest(raw):
    index = json.loads(raw)
    if not isinstance(index, dict) or index.get("schemaVersion") != 2 or index.get("mediaType") not in (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
    ):
        raise ValueError("Expected a multi-architecture image index.")
    manifests = index.get("manifests")
    if not isinstance(manifests, list) or len(manifests) != 2:
        raise ValueError("Expected exactly linux/amd64 and linux/arm64 images.")
    platforms = []
    for manifest in manifests:
        if not isinstance(manifest, dict) or not isinstance(manifest.get("platform"), dict):
            raise ValueError("Missing image platform.")
        digest = manifest.get("digest")
        if (
            manifest.get("mediaType") not in (
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.v2+json",
            )
            or not isinstance(digest, str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
            or type(manifest.get("size")) is not int
            or manifest["size"] <= 0
        ):
            raise ValueError("Invalid image manifest descriptor.")
        platform = manifest["platform"]
        platforms.append((platform.get("os"), platform.get("architecture")))
    if set(platforms) != {("linux", "amd64"), ("linux", "arm64")}:
        raise ValueError("Expected exactly linux/amd64 and linux/arm64 images.")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


if __name__ == "__main__":
    try:
        print(index_digest(sys.stdin.buffer.read()))
    except (ValueError, TypeError) as error:
        sys.exit(str(error))
