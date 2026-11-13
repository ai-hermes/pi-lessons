# Offline image store

Image MCP release archives are downloaded here as
`agentgateway-image-mcp-v1.0.0-<commit>-amd64.tar`.
The global `images.manifest.tsv` is synchronized from `bd://deploy/images/`.
Archives and that shared index are local deployment outputs, not Git content.
Use the versioned project's `images.lock` when selecting images for deployment.
