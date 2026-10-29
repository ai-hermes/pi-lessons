import type { FindOperations } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import type { ActiveOpenSandbox } from "./client.ts";
import { shellQuote } from "./client.ts";

export interface GrepParams {
  context?: number;
  glob?: string;
  ignoreCase?: boolean;
  limit?: number;
  literal?: boolean;
  path?: string;
  pattern: string;
}

interface RemoteSearchResult {
  content: { text: string; type: "text" }[];
  details: undefined;
}

const maxSearchOutputBytes = 30 * 1024;

export function createFindOperations(
  requireActiveSandbox: () => ActiveOpenSandbox,
): FindOperations {
  return {
    exists: async (path) => {
      return await requireActiveSandbox().getFileInfo(path) !== undefined;
    },
    glob: async (pattern, cwd, { ignore, limit }) => {
      const activeSandbox = requireActiveSandbox();
      const sandboxCwd = activeSandbox.resolveReadablePath(cwd);
      const files = await activeSandbox.searchFiles(cwd, pattern);
      return files
        .map((file) => posix.relative(sandboxCwd, file.path))
        .filter((path) => !ignore.some((ignored) => posix.matchesGlob(path, ignored)))
        .slice(0, limit);
    },
  };
}

export async function runRemoteGrep(
  activeSandbox: ActiveOpenSandbox,
  params: GrepParams,
  signal?: AbortSignal,
): Promise<RemoteSearchResult> {
  const limit = normalizePositiveInteger(params.limit, 100);
  const context = normalizeNonNegativeInteger(params.context);
  const searchPath = activeSandbox.resolveReadablePath(params.path ?? ".");
  const command = buildRemoteGrepScript(searchPath, params, context, limit);

  // Run the generated search script inside the Sandbox and bound the captured
  // output so a broad search cannot consume unbounded host memory.
  const result = await activeSandbox.runCommand(
    command,
    activeSandbox.sandboxWorkspaceRoot,
    {
      captureOutput: true,
      maxOutputBytes: maxSearchOutputBytes,
      ...(signal ? { signal } : {}),
    },
  );
  if (result.exitCode !== 0) {
    const detail = result.output.trim();
    throw new Error(
      `grep failed in ${params.path ?? "."} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }

  // Remote tools may emit POSIX-relative paths and CRLF line endings. Normalize
  // both before returning the text through Pi's grep tool interface.
  const output = result.output
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").replace(/\r$/, ""))
    .join("\n")
    .replace(/[\r\n]+$/, "");
  return textResult(
    output || `No matches found for /${params.pattern}/ in ${params.path ?? "."}`,
    result.outputTruncated
  );
}

function buildRemoteGrepScript(
  searchPath: string,
  params: GrepParams,
  context: number,
  limit: number,
): string {
  const commands = buildRemoteGrepCommands(params, context);

  return `
# Search directories from within themselves so result paths stay relative. For
# a single file, search from its parent directory and use its basename.
__pi_path=${shellQuote(searchPath)}
if [ -d "$__pi_path" ]; then
  cd "$__pi_path" || exit 1
  __pi_target=.
else
  cd "$(dirname "$__pi_path")" || exit 1
  __pi_target="$(basename "$__pi_path")"
fi

# Capture stdout and stderr separately so grep's exit code can be interpreted
# before any result limit is applied.
__pi_out=$(mktemp 2>/dev/null || echo "/tmp/pi-opensandbox-grep-$$.out")
__pi_err="$__pi_out.err"

# Prefer ripgrep, fall back to a grep with filtering options, then use basic
# grep and remove matches from ignored directories afterwards.
if command -v rg >/dev/null 2>&1; then
  ${commands.ripgrep} >"$__pi_out" 2>"$__pi_err"
elif grep --help 2>&1 | grep -q exclude-dir; then
  ${commands.extendedGrep} >"$__pi_out" 2>"$__pi_err"
else
  ${commands.basicGrep} >"$__pi_out" 2>"$__pi_err"
  __pi_rc=$?
  grep -vE '(^|/)(\\.git|node_modules)/' "$__pi_out" >"$__pi_out.f"
  mv "$__pi_out.f" "$__pi_out"
  [ "$__pi_rc" -eq 0 ] && [ ! -s "$__pi_out" ] && __pi_rc=1
  (exit "$__pi_rc")
fi

# Exit code 1 means "no matches"; any other non-zero code is a search error.
__pi_rc=$?
case "$__pi_rc" in
  0|1) ;;
  *) head -c 2048 "$__pi_err"; rm -f "$__pi_out" "$__pi_err"; exit "$__pi_rc" ;;
esac

# Return at most the requested number of lines and remove temporary files.
head -n ${limit} "$__pi_out"
rm -f "$__pi_out" "$__pi_err"
`.trim();
}

function buildRemoteGrepCommands(
  params: GrepParams,
  context: number,
): {
  basicGrep: string;
  extendedGrep: string;
  ripgrep: string;
} {
  const target = '"$__pi_target"';
  const rgArgs = ["rg", "--line-number", "--no-heading", "--color=never", "--hidden"];
  if (params.ignoreCase) rgArgs.push("--ignore-case");
  if (params.literal) rgArgs.push("--fixed-strings");
  if (context) rgArgs.push("--context", String(context));
  if (params.glob) rgArgs.push("--glob", shellQuote(params.glob));
  rgArgs.push(
    "-g",
    shellQuote("!**/.git/**"),
    "-g",
    shellQuote("!**/node_modules/**"),
    "--",
    shellQuote(params.pattern),
    target,
  );

  const grepArgs = ["grep", "-rnI"];
  if (params.ignoreCase) grepArgs.push("-i");
  if (params.literal) grepArgs.push("-F");
  if (context) grepArgs.push("-C", String(context));
  if (params.glob) grepArgs.push(`--include=${shellQuote(params.glob)}`);
  grepArgs.push(
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--",
    shellQuote(params.pattern),
    target,
  );

  // BusyBox grep lacks `-I`, `--include`, and `--exclude-dir`, so its results
  // are filtered by the generated script after the search completes.
  const basicGrepArgs = ["grep", "-rn"];
  if (params.ignoreCase) basicGrepArgs.push("-i");
  if (params.literal) basicGrepArgs.push("-F");
  if (context) basicGrepArgs.push("-C", String(context));
  basicGrepArgs.push("--", shellQuote(params.pattern), target);

  return {
    basicGrep: basicGrepArgs.join(" "),
    extendedGrep: grepArgs.join(" "),
    ripgrep: rgArgs.join(" "),
  };
}

function textResult(text: string, truncated = false): RemoteSearchResult {
  return {
    content: [
      {
        type: "text",
        text: `${text}${truncated ? "\n\n[Output truncated: 30 KiB limit reached]" : ""}`,
      }
    ],
    details: undefined,
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));
}
