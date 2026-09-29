import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions, probe, sleepN } from "./config";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  useServerProxy: true,
});

let sandbox: Sandbox | null = null;
try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine-curl:8.22.0",
    timeoutSeconds: 10 * 60,
    networkPolicy: {
      defaultAction: "deny",
      egress: [
        {
          action: "allow",
          target: "example.com",
        },
      ],
    },
  });

  const policy = await sandbox.getEgressPolicy();
  console.log(`Initial policy: ${JSON.stringify(policy)}`);

  const ret1 = await probe(sandbox, "https://example.com");
  console.log("https://example.com", ret1);

  const ret2 = await probe(sandbox, "https://api.github.com");
  console.log("https://api.github.com", ret2);

  await sandbox.patchEgressRules([
    {
      action: "allow",
      target: "api.github.com",
    },
  ]);
  const ret3 = await probe(sandbox, "https://api.github.com");
  console.log("https://api.github.com", ret3);
  await sandbox.kill();
} finally {
  await sandbox?.close();
}
