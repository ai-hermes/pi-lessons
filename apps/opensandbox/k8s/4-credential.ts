import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config.ts";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  requestTimeoutSeconds: 60,
  useServerProxy: true,
});

const headerName = "X-Credential-Vault-Demo";
const testToken = "credential-vault-demo-token"; // 仅用于 httpbin 回显验证，不能替换为真实密钥。

let sandbox: Sandbox | undefined;

try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine-curl:8.22.0",
    timeoutSeconds: 10 * 60,
    credentialProxy: { enabled: true },
    networkPolicy: {
      defaultAction: "deny",
      egress: [{ action: "allow", target: "httpbin.org" }],
    },
  });

  await sandbox.credentialVault.create({
    credentials: [{ name: "httpbin-token", source: { value: testToken } }],
    bindings: [
      {
        name: "httpbin-header",
        match: { schemes: ["https"], hosts: ["httpbin.org"], paths: ["/headers"] },
        auth: {
          type: "customHeaders",
          headers: [{ name: headerName, credential: "httpbin-token" }],
        },
      },
    ],
  });

  const result = await sandbox.commands.run(
    "curl -fsS --max-time 20 https://httpbin.org/headers",
  );
  const { headers } = JSON.parse(
    result.logs.stdout.map(({ text }) => text).join(""),
  ) as { headers: Record<string, string> };
  const injectedToken = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === headerName.toLowerCase(),
  )?.[1];

  if (injectedToken !== testToken) {
    throw new Error("Credential Vault did not inject the expected header.");
  }
  console.log("Credential Vault injected the custom header.");
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
    } finally {
      await sandbox.close();
    }
  }
}
