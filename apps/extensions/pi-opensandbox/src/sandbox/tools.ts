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
import type { ActiveOpenSandbox } from "./client";
import { createFindOperations, runRemoteGrep, type GrepParams } from "./search";

/**
 * Replaces Pi's filesystem, search, and shell tools with remote implementations.
 *
 * `requireActiveSandbox` must reject when remote execution is unavailable so a
 * remote-mode tool call can never silently fall back to the host workspace.
 *
 * @example
 * ```ts
 * registerOpenSandboxTools(
 *   pi,
 *   () => session.requireActiveSandbox(),
 *   () => session.getHostWorkspaceRoot(),
 * );
 * ```
 */
export function registerOpenSandboxTools(
  pi: ExtensionAPI,
  requireActiveSandbox: () => Promise<ActiveOpenSandbox>,
  getHostWorkspaceRoot: () => string,
): void {
  const hostWorkspaceRoot = getHostWorkspaceRoot();
  const localGrep = createGrepTool(hostWorkspaceRoot);
  pi.registerTool(
    createBashTool(hostWorkspaceRoot, {
      operations: createBashOperations(requireActiveSandbox),
    }),
  );
  pi.registerTool(
    createReadTool(hostWorkspaceRoot, {
      operations: createReadOperations(requireActiveSandbox),
    })
  );
  pi.registerTool(
    createWriteTool(hostWorkspaceRoot, {
      operations: createWriteOperations(requireActiveSandbox),
    })
  );
  pi.registerTool(
    createEditTool(hostWorkspaceRoot, {
      operations: createEditOperations(requireActiveSandbox),
    })
  );
  pi.registerTool(
    createLsTool(hostWorkspaceRoot, {
      operations: createLsOperations(requireActiveSandbox),
    })
  );
  pi.registerTool(
    createFindTool(hostWorkspaceRoot, {
      operations: createFindOperations(requireActiveSandbox),
    })
  );

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal) {
      const activeSandbox = await requireActiveSandbox();
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      return runRemoteGrep(activeSandbox, params as GrepParams, signal);
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
      const url = await (await requireActiveSandbox()).getEndpointUrl(port);
      return {
        content: [{ type: "text" as const, text: `OpenSandbox URL for port ${port}: ${url}` }],
        details: { port, url },
      };
    },
  });

  pi.on("user_bash", async () => {
    const activeSandbox = await requireActiveSandbox();
    return {
      operations: createBashOperations(
        async () => activeSandbox,
        activeSandbox.sandboxWorkspaceRoot,
      ),
    };
  });
}
