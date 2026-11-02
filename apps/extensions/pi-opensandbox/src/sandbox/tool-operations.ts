import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { OpenSandboxHandle } from "./client";
import { shellQuote } from "./client";
import { isOpenSandboxTransportError } from "./logger";

const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type WithActiveSandboxHandle = <T>(
  operation: (sandboxHandle: OpenSandboxHandle) => Promise<T>,
) => Promise<T>;

/**
 * Creates Pi bash operations that execute commands in the active sandbox.
 *
 * Both the bash tool and user `!` commands receive the host session cwd, which
 * always maps to the sandbox workspace root, so commands run there directly.
 */
export function createBashOperations(
  withActiveSandboxHandle: WithActiveSandboxHandle,
): BashOperations {
  return {
    exec: (command, _cwd, options) => withActiveSandboxHandle(async (sandboxHandle) => {
      // Execute the caller-provided shell command while forwarding Pi environment
      // variables, output events, cancellation, and the requested timeout.
      const result = await sandboxHandle.runCommand(
        command,
        sandboxHandle.sandboxWorkspaceRoot,
        {
          onData: options.onData,
          env: buildForwardedPiEnvironment(options.env ?? {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeout !== undefined ? { timeoutSeconds: options.timeout } : {}),
        },
      );
      return { exitCode: result.exitCode };
    }),
  };
}

function buildForwardedPiEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    AI_AGENT: "pi",
    PI_CODING_AGENT: "true",
    ...Object.fromEntries(
      [
        "PI_SESSION_ID",
        "PI_SESSION_FILE",
        "PI_PROVIDER",
        "PI_MODEL",
        "PI_REASONING_LEVEL",
      ]
        .map((name) => [name, env[name] ?? process.env[name]] as const)
        .filter(([, value]) => value !== undefined),
    ),
  };
}

/** Creates Pi read operations backed by sandbox file APIs and MIME detection. */
export function createReadOperations(
  withActiveSandboxHandle: WithActiveSandboxHandle,
): ReadOperations {
  return {
    readFile: (path) => withActiveSandboxHandle(
      (sandboxHandle) => sandboxHandle.readFile(path),
    ),
    access: (path) => withActiveSandboxHandle(async (sandboxHandle) => {
      const metadata = await sandboxHandle.getFileInfo(path);
      if (!metadata) {
        throw new Error(`Path not found: ${path}`);
      }
    }),
    detectImageMimeType: async (path) => {
      try {
        return await withActiveSandboxHandle(async (sandboxHandle) => {
          const sandboxPath = sandboxHandle.resolveReadablePath(path);

          // Ask `file` for only the MIME type (`-b` omits the path prefix) so the
          // result can be checked against the image types supported by Pi.
          const result = await sandboxHandle.runCommand(
            `file --mime-type -b ${shellQuote(sandboxPath)}`,
            sandboxHandle.sandboxWorkspaceRoot,
            {
              captureOutput: true,
              maxOutputBytes: 1024
            },
          );
          const mimeType = result.output.trim();
          return imageMimeTypes.has(mimeType) ? mimeType : null;
        });
      } catch (error) {
        if (isOpenSandboxTransportError(error)) throw error;
        return null;
      }
    },
  };
}

/** Creates workspace-restricted Pi write operations for the active sandbox. */
export function createWriteOperations(
  withActiveSandboxHandle: WithActiveSandboxHandle,
): WriteOperations {
  return {
    writeFile: (path, content) => withActiveSandboxHandle(
      (sandboxHandle) => sandboxHandle.writeFile(path, content),
    ),
    mkdir: (path) => withActiveSandboxHandle(
      (sandboxHandle) => sandboxHandle.createDirectory(path),
    ),
  };
}

/** Combines remote read/write operations with an explicit writability check. */
export function createEditOperations(
  withActiveSandboxHandle: WithActiveSandboxHandle,
): EditOperations {
  const read = createReadOperations(withActiveSandboxHandle);
  const write = createWriteOperations(withActiveSandboxHandle);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: (path) => withActiveSandboxHandle(async (sandboxHandle) => {
      const sandboxPath = sandboxHandle.resolveReadablePath(path);

      // POSIX `test` exits with 0 when its condition is true. The path must
      // pass both the readable (`-r`) and writable (`-w`) checks.
      const result = await sandboxHandle.runCommand(
        `test -r ${shellQuote(sandboxPath)} && test -w ${shellQuote(sandboxPath)}`,
        sandboxHandle.sandboxWorkspaceRoot,
      );
      if (result.exitCode !== 0) {
        throw new Error(`Path is not readable and writable: ${path}`);
      }
    }),
  };
}

/** Creates directory listing and metadata operations for remote paths. */
export function createLsOperations(
  withActiveSandboxHandle: WithActiveSandboxHandle,
): LsOperations {
  return {
    exists: (path) => withActiveSandboxHandle(async (sandboxHandle) => {
      // POSIX `test -e` exits with 0 when the resolved path exists.
      const result = await sandboxHandle.runCommand(
        `test -e ${shellQuote(sandboxHandle.resolveReadablePath(path))}`,
        sandboxHandle.sandboxWorkspaceRoot,
      );
      return result.exitCode === 0;
    }),
    stat: (path) => withActiveSandboxHandle(async (sandboxHandle) => {
      const sandboxPath = sandboxHandle.resolveReadablePath(path);

      // Fail when the path does not exist; otherwise print a small type marker
      // that distinguishes directories from other filesystem entries.
      const result = await sandboxHandle.runCommand(
        `test -e ${shellQuote(sandboxPath)} || exit 1; `
        + `test -d ${shellQuote(sandboxPath)} && echo directory || echo file`,
        sandboxHandle.sandboxWorkspaceRoot,
        {
          captureOutput: true,
          maxOutputBytes: 128
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Path not found: ${path}`);
      }
      return {
        isDirectory: () => result.output.trim() === "directory"
      };
    }),
    readdir: (path) => withActiveSandboxHandle(async (sandboxHandle) => {
      const sandboxPath = sandboxHandle.resolveReadablePath(path);

      // List one entry per line, including hidden entries but excluding "." and "..".
      const result = await sandboxHandle.runCommand(
        `ls -1A ${shellQuote(sandboxPath)}`,
        sandboxHandle.sandboxWorkspaceRoot,
        {
          captureOutput: true
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Cannot read directory: ${path}`);
      }
      return result.output
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter(Boolean);
    }),
  };
}
