import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { ActiveOpenSandbox } from "./client";
import { shellQuote } from "./client";

const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Creates Pi bash operations that execute commands in the active sandbox. */
export function createBashOperations(
  requireActiveSandbox: () => Promise<ActiveOpenSandbox>,
  cwdOverride?: string,
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const activeSandbox = await requireActiveSandbox();
      const sandboxWorkingDirectory = cwdOverride ?? activeSandbox.resolveReadablePath(cwd);

      // Execute the caller-provided shell command while forwarding Pi environment
      // variables, output events, cancellation, and the requested timeout.
      const result = await activeSandbox.runCommand(command, sandboxWorkingDirectory, {
        onData: options.onData,
        env: buildForwardedPiEnvironment(options.env ?? {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeout !== undefined ? { timeoutSeconds: options.timeout } : {}),
      });
      return { exitCode: result.exitCode };
    },
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
  requireActiveSandbox: () => Promise<ActiveOpenSandbox>,
): ReadOperations {
  return {
    readFile: async (path) => {
      return (await requireActiveSandbox()).readFile(path);
    },
    access: async (path) => {
      const metadata = await (await requireActiveSandbox()).getFileInfo(path);
      if (!metadata) {
        throw new Error(`Path not found: ${path}`);
      }
    },
    detectImageMimeType: async (path) => {
      try {
        const activeSandbox = await requireActiveSandbox();
        const sandboxPath = activeSandbox.resolveReadablePath(path);

        // Ask `file` for only the MIME type (`-b` omits the path prefix) so the
        // result can be checked against the image types supported by Pi.
        const result = await activeSandbox.runCommand(
          `file --mime-type -b ${shellQuote(sandboxPath)}`,
          activeSandbox.sandboxWorkspaceRoot,
          {
            captureOutput: true,
            maxOutputBytes: 1024
          },
        );
        const mimeType = result.output.trim();
        return imageMimeTypes.has(mimeType) ? mimeType : null;
      } catch {
        return null;
      }
    },
  };
}

/** Creates workspace-restricted Pi write operations for the active sandbox. */
export function createWriteOperations(
  requireActiveSandbox: () => Promise<ActiveOpenSandbox>,
): WriteOperations {
  return {
    writeFile: async (path, content) => {
      await (await requireActiveSandbox()).writeFile(path, content);
    },
    mkdir: async (path) => {
      await (await requireActiveSandbox()).createDirectory(path);
    },
  };
}

/** Combines remote read/write operations with an explicit writability check. */
export function createEditOperations(
  requireActiveSandbox: () => Promise<ActiveOpenSandbox>,
): EditOperations {
  const read = createReadOperations(requireActiveSandbox);
  const write = createWriteOperations(requireActiveSandbox);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (path) => {
      const activeSandbox = await requireActiveSandbox();
      const sandboxPath = activeSandbox.resolveReadablePath(path);

      // POSIX `test` exits with 0 when its condition is true. The path must
      // pass both the readable (`-r`) and writable (`-w`) checks.
      const result = await activeSandbox.runCommand(
        `test -r ${shellQuote(sandboxPath)} && test -w ${shellQuote(sandboxPath)}`,
        activeSandbox.sandboxWorkspaceRoot,
      );
      if (result.exitCode !== 0) {
        throw new Error(`Path is not readable and writable: ${path}`);
      }
    },
  };
}

/** Creates directory listing and metadata operations for remote paths. */
export function createLsOperations(
  requireActiveSandbox: () => Promise<ActiveOpenSandbox>,
): LsOperations {
  return {
    exists: async (path) => {
      const activeSandbox = await requireActiveSandbox();

      // POSIX `test -e` exits with 0 when the resolved path exists.
      const result = await activeSandbox.runCommand(
        `test -e ${shellQuote(activeSandbox.resolveReadablePath(path))}`,
        activeSandbox.sandboxWorkspaceRoot,
      );
      return result.exitCode === 0;
    },
    stat: async (path) => {
      const activeSandbox = await requireActiveSandbox();
      const sandboxPath = activeSandbox.resolveReadablePath(path);

      // Fail when the path does not exist; otherwise print a small type marker
      // that distinguishes directories from other filesystem entries.
      const result = await activeSandbox.runCommand(
        `test -e ${shellQuote(sandboxPath)} || exit 1; `
        + `test -d ${shellQuote(sandboxPath)} && echo directory || echo file`,
        activeSandbox.sandboxWorkspaceRoot,
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
    },
    readdir: async (path) => {
      const activeSandbox = await requireActiveSandbox();
      const sandboxPath = activeSandbox.resolveReadablePath(path);

      // List one entry per line, including hidden entries but excluding "." and "..".
      const result = await activeSandbox.runCommand(
        `ls -1A ${shellQuote(sandboxPath)}`,
        activeSandbox.sandboxWorkspaceRoot,
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
    },
  };
}
