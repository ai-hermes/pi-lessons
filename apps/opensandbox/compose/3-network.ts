import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  requestTimeoutSeconds: 60,
  useServerProxy: true,
});

let sandbox: Sandbox | undefined;

async function probe(sandbox: Sandbox, url: string) {
  const result = await sandbox.commands.run(`curl -sSI --max-time 10 ${url}`);
  const output = [...result.logs.stdout, ...result.logs.stderr]
    .map(({ text }) => text)
    .join("")
    .trim()
    .split("\n")[0];

  console.log(`${url}: exit=${result.exitCode ?? "unknown"} ${output}`);
  return result.exitCode === 0;
}

try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine-curl:8.22.0",
    timeoutSeconds: 10 * 60,
    networkPolicy: {
      defaultAction: "deny",
      egress: [{ action: "allow", target: "example.com" }],
    },
  });

  const policy = await sandbox.getEgressPolicy();
  console.log("Initial policy:", policy);

  console.log("\n1. default deny: api.github.com should fail");
  if (await probe(sandbox, "https://api.github.com")) {
    throw new Error("api.github.com should be blocked before it is allowlisted.");
  }

  console.log("\n2. example.com is allowlisted and should succeed");
  if (!(await probe(sandbox, "https://example.com"))) {
    throw new Error("example.com should be allowed.");
  }

  await sandbox.patchEgressRules([{ action: "allow", target: "api.github.com" }]);
  console.log("Updated policy:", await sandbox.getEgressPolicy());

  console.log("\n3. api.github.com is now allowlisted and should succeed");
  if (!(await probe(sandbox, "https://api.github.com"))) {
    throw new Error("api.github.com should be allowed after the policy update.");
  }
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
    } finally {
      await sandbox.close();
    }
  }
}
