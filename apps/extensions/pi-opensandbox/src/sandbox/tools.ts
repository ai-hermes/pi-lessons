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
  type WithActiveSandboxHandle,
} from "./tool-operations";
import { createFindOperations, runRemoteGrep, type GrepParams } from "./search";

/**
 * Replaces Pi's `bash`, `read`, `write`, `edit`, `ls`, `find`, and `grep`
 * tools, and handles user `!` shell commands with remote implementations.
 *
 * `withActiveSandboxHandle` must reject when remote execution is unavailable
 * so a remote-mode tool call can never silently fall back to the host workspace.
 *
 * @example
 * ```ts
 * registerOpenSandboxTools(
 *   pi,
 *   (operation) => session.withActiveSandboxHandle(operation),
 *   () => session.getHostWorkspaceRoot(),
 * );
 * ```
 */
export function registerOpenSandboxTools(
  pi: ExtensionAPI,
  withActiveSandboxHandle: WithActiveSandboxHandle,
  getHostWorkspaceRoot: () => string,
): void {
  const hostWorkspaceRoot = getHostWorkspaceRoot();
  const localGrep = createGrepTool(hostWorkspaceRoot);
  pi.registerTool(
    createBashTool(hostWorkspaceRoot, {
      operations: createBashOperations(withActiveSandboxHandle),
    }),
  );
  pi.registerTool(
    createReadTool(hostWorkspaceRoot, {
      operations: createReadOperations(withActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createWriteTool(hostWorkspaceRoot, {
      operations: createWriteOperations(withActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createEditTool(hostWorkspaceRoot, {
      operations: createEditOperations(withActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createLsTool(hostWorkspaceRoot, {
      operations: createLsOperations(withActiveSandboxHandle),
    })
  );
  pi.registerTool(
    createFindTool(hostWorkspaceRoot, {
      operations: createFindOperations(withActiveSandboxHandle),
    })
  );

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      return withActiveSandboxHandle(
        (sandboxHandle) => runRemoteGrep(sandboxHandle, params as GrepParams, signal),
      );
    },
  });

  // user -> domain -> ${domain}/v1/sandboxes/${sandboxId}/proxy/8080/mcp
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
      const url = await withActiveSandboxHandle(
        (sandboxHandle) => sandboxHandle.getEndpointUrl(port),
      );
      return {
        content: [{ type: "text" as const, text: `OpenSandbox URL for port ${port}: ${url}` }],
        details: { port, url },
      };
    },
  });

  pi.on("user_bash", () => ({
    operations: createBashOperations(withActiveSandboxHandle),
  }));
}
