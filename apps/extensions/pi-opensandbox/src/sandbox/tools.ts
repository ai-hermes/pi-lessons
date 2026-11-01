import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createBashOperations,
  createEditOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
} from "./tool-operations";
import type { OpenSandboxHandle } from "./client";
import { createFindOperations, runRemoteGrep, type GrepParams } from "./search";

/**
 * Replaces Pi's `bash`, `read`, `write`, `edit`, `ls`, `find`, and `grep`
 * tools, and handles user `!` shell commands with remote implementations.
 *
 * `requireActiveSandboxHandle` must reject when remote execution is unavailable so a
 * remote-mode tool call can never silently fall back to the host workspace.
 *
 * @example
 * ```ts
 * registerOpenSandboxTools(
 *   pi,
 *   () => session.requireActiveSandboxHandle(),
 *   () => session.getHostWorkspaceRoot(),
 * );
 * ```
 */
export function registerOpenSandboxTools(
  pi: ExtensionAPI,
  requireActiveSandboxHandle: () => Promise<OpenSandboxHandle>,
  getHostWorkspaceRoot: () => string,
): void {
  const hostWorkspaceRoot = getHostWorkspaceRoot();
  const localGrep = createGrepTool(hostWorkspaceRoot);
  pi.registerTool(
    createBashTool(hostWorkspaceRoot, {
      operations: createBashOperations(requireActiveSandboxHandle),
    }),
  );
  pi.registerTool(
    createReadTool(hostWorkspaceRoot, {
      operations: createReadOperations(requireActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createWriteTool(hostWorkspaceRoot, {
      operations: createWriteOperations(requireActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createEditTool(hostWorkspaceRoot, {
      operations: createEditOperations(requireActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createLsTool(hostWorkspaceRoot, {
      operations: createLsOperations(requireActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createFindTool(hostWorkspaceRoot, {
      operations: createFindOperations(requireActiveSandboxHandle),
    })
  );

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal) {
      const sandboxHandle = await requireActiveSandboxHandle();
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      return runRemoteGrep(sandboxHandle, params as GrepParams, signal);
    },
  });

  pi.registerTool({
    name: "opensandbox_port_url",
    label: "OpenSandbox Port URL",
    description: "Get the endpoint URL for a port exposed by the active OpenSandbox sandbox.",
    promptSnippet: "Get an OpenSandbox endpoint URL for a running service",
    parameters: Type.Object({
      port: Type.Integer({
        minimum: 1,
        maximum: 65535
      }),
    }),
    async execute(_toolCallId, { port }) {
      const url = await (await requireActiveSandboxHandle()).getEndpointUrl(port);
      return {
        content: [{ type: "text" as const, text: `OpenSandbox URL for port ${port}: ${url}` }],
        details: { port, url },
      };
    },
  });

  pi.on("user_bash", async () => {
    const sandboxHandle = await requireActiveSandboxHandle();
    return {
      operations: createBashOperations(
        async () => sandboxHandle,
        sandboxHandle.sandboxWorkspaceRoot,
      ),
    };
  });
}
