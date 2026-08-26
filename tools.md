# Available Tools

## 1. read
Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.

- **Parameters**: `path` (required), `offset` (optional, line number to start from, 1-indexed), `limit` (optional, max lines)

## 2. bash
Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.

- **Parameters**: `command` (required), `timeout` (optional, in seconds)

## 3. edit
Edit a single file using exact text replacement. Every `oldText` must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. Supports multiple disjoint edits in one call.

- **Parameters**: `path` (required), `edits` (required, array of `{ oldText, newText }`)

## 4. write
Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Use only for new files or complete rewrites.

- **Parameters**: `path` (required), `content` (required)
