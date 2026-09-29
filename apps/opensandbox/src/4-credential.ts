import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions, probe, sleepN } from "./config";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  useServerProxy: true,
});

let sandbox: Sandbox | null = null;
const headerName = "X-Credential-Vault-Demo";
const testToken = "credential-vault-demo-token";
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
    credentials: [
      {
        name: "httpbin-token",
        source: { value: testToken },
      },
    ],
    bindings: [
      {
        name: "httpbin-header",
        match: {
          schemes: ["https"],
          hosts: ["httpbin.org"],
          paths: ["/headers"],
        },
        auth: {
          type: "customHeaders",
          headers: [
            {
              name: headerName,
              credential: "httpbin-token",
            },
          ],
        },
      },
    ],
  });

  const result = await sandbox.commands.run("curl -fsS --max-time 20 https://httpbin.org/headers");
  const { headers } = JSON.parse(result.logs.stdout.map(({ text }) => text).join("")) as {
    headers: Record<string, string>;
  };
  console.log(JSON.stringify(headers));
  await sandbox.kill();
} finally {
  await sandbox?.close();
}
