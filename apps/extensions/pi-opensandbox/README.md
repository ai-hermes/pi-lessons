# @ai.hermes/pi-opensandbox

Standalone Pi extension that runs Pi's file, search, and shell tools inside OpenSandbox. It includes optional Skill mirroring and does not depend on another OpenSandbox extension.

## Structure

- `package.json`: Pi package manifest; `pi.extensions` points to `./src/index.ts`.
- `.env.example`: local environment template with inline and file-based configuration examples.
- `src/index.ts`: minimal Pi package entry point.
- `src/config.ts`: configuration loading, parsing, validation, and normalization.
- `src/extension.ts`: the only composition layer for Pi events, commands, and lifecycle.
- `src/skills.ts`: optional Skill validation, immutable cache, upload, and verification.
- `src/sandbox/`: OpenSandbox configuration, active Sandbox module, session state, and Pi tool adapters.
- `test/`: configuration and integration tests.
- `dist/`: generated JavaScript and declarations for Node.js consumers (not committed).

This follows Pi's [package-with-dependencies layout](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#extension-styles).
Pi loads the TypeScript entry directly; building is only needed for Node.js
imports and the compiled test suite.

## What it does

1. Creates, connects to, or resumes an OpenSandbox sandbox for each Pi session.
2. Routes Pi's built-in file, search, shell, and user shell operations into it.
3. Rewrites Pi's working-directory context to the remote workspace.
4. Applies sandbox lifecycle, network, resource, and timeout configuration.
5. Optionally mirrors selected Skills and verifies their remote SHA-256 content.

## Install and check

```bash
# From the repository root:
pnpm install
pnpm build:pi-opensandbox
pnpm typecheck:pi-opensandbox
pnpm test:pi-opensandbox
```

This example lives in `apps/extensions/pi-opensandbox` and is registered as the
`@ai.hermes/pi-opensandbox` workspace package. Add other extension examples as
sibling directories under `apps/extensions/`, each with its own `package.json`.

## Integration

Install the published Pi package:

```bash
pi install npm:@ai.hermes/pi-opensandbox
```

Then run `/opensandbox-config` in Pi to show status, configure and enable the
remote sandbox, or disable it. Configuration is stored for the current user at
`~/.pi/agent/extensions/opensandbox.json` with file mode `0600`. The API key is
masked while entering it in TUI mode. In RPC mode, set
`OPENSANDBOX_API_KEY` instead.

For local development, install the package from the repository root:

```bash
pi install ./apps/extensions/pi-opensandbox
```

For local development, copy the extension environment template and fill in the
API key and an image that your OpenSandbox deployment can pull:

```bash
cp apps/extensions/pi-opensandbox/.env.example \
  apps/extensions/pi-opensandbox/.env
```

The template keeps the structured configuration inline in
`PI_OPENSANDBOX_CONFIG` and the secret in `OPENSANDBOX_API_KEY`:

```dotenv
OPENSANDBOX_API_KEY=your-api-key
PI_OPENSANDBOX_CONFIG='{"sandboxConfig":{"domain":"http://127.0.0.1:18080","image":"your-sandbox-image","timeoutSeconds":600,"lifecycle":{"onSessionShutdown":"kill"}}}'
```

Load the environment and run the TypeScript extension directly; no build is
required:

```bash
set -a
source apps/extensions/pi-opensandbox/.env
set +a

pi --extension ./apps/extensions/pi-opensandbox/src/index.ts
```

The JSON object uses the `PiOpenSandboxOptions` shape:

```json
{
  "sandboxConfig": {
    "domain": "sandbox.internal:8080",
    "image": "opensandbox/code-interpreter:v1.1.0"
  },
  "skills": [
    { "sourceDir": "/srv/pi/skill-store/pdf" }
  ],
  "sharedSkillRoot": "/tmp/piworker/tasks/my-task/.agents/skills",
  "skillSyncLimits": {
    "maxFiles": 10000,
    "maxFileBytes": 8388608,
    "maxTotalBytes": 134217728
  },
  "verifyUploadedSkills": true
}
```

Set exactly one of `PI_OPENSANDBOX_CONFIG` or
`PI_OPENSANDBOX_CONFIG_FILE`. For larger production configurations, replace
the inline variable with an absolute configuration file path:

```dotenv
OPENSANDBOX_API_KEY=your-api-key
PI_OPENSANDBOX_CONFIG_FILE=/absolute/path/to/opensandbox.json
```

The referenced `opensandbox.json` contains the same `PiOpenSandboxOptions` JSON
object shown above. The `.env.example` file includes both alternatives and an
example of the referenced file contents; the file-based variable remains
commented out so the two variables are not enabled together.

Embedding services can build the package with `pnpm build:pi-opensandbox`,
then import the named `createPiOpenSandboxExtension` export from
`@ai.hermes/pi-opensandbox` and pass the returned extension to their Pi session.
The Node.js package export remains `dist/index.js`, with declarations at
`dist/index.d.ts`. Published packages include both `src/` (for Pi) and `dist/`
(for Node.js).

`skills` and `sharedSkillRoot` are optional, but must be configured together.
`skillSyncLimits` controls Skill upload limits, while
`verifyUploadedSkills` defaults to `true`.
`sharedSkillRoot` must be a normalized absolute POSIX path unique to the task/session and containing a `skills` path segment, for example:

```text
/tmp/piworker/tasks/<task-id>/.agents/skills
```

The embedding service—not model-generated input—must choose `skills`, `sandboxConfig`, credentials, volume mounts, and network policy.

## Publishing

The `pi-package` keyword and `pi.extensions` manifest entry make the package
discoverable by npm-backed Pi package search; no separate Pi reporting API is
required.

The first scoped release must be published manually:

```bash
pnpm build:pi-opensandbox
cd apps/extensions/pi-opensandbox
npm publish --access public
```

After `@ai.hermes/pi-opensandbox@0.1.0` exists, configure npm Trusted Publisher
for this GitHub repository and `.github/workflows/pi-opensandbox-release.yml`.
Subsequent merges to `main` that change this extension automatically publish
the next patch version. Until the first release exists, that workflow exits
successfully without publishing.

## Logs

The extension writes structured lifecycle and cleanup errors to the matching
console stream. Every line starts with `[pi-opensandbox]` and contains a JSON
payload that can be filtered by `component`, `event`, or `sandboxId`:

```text
[pi-opensandbox] {"timestamp":"2026-10-30T08:00:00.000Z","component":"pi-extension-opensandbox","event":"sandbox.cleanup.kill.error","sandboxId":"sandbox-123","errorName":"Error","errorMessage":"Request failed: token=[REDACTED]","errorStack":"..."}
```

Common credential patterns such as API keys, passwords, tokens, and bearer
tokens are redacted before the event is written.

## Important boundary

`resourceRoots` constrains the extension's file/search tools. It does not make a filesystem path read-only to arbitrary shell commands. Enforce actual read-only access through the OpenSandbox image, container user, or a read-only volume mount.
