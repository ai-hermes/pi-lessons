import { ConnectionConfig, Sandbox, SandboxException } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions, requiredEnv } from "../config.ts";
let sandbox: Sandbox | null = null;
const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  useServerProxy: true,
});
const filename = "/data/host-volume-demo.txt";
const content = `Written at ${new Date().toISOString()}\n`;
const hostPath = requiredEnv("HOST_VOLUME_PATH");
try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
    volumes: [
      {
        name: "host-data",
        host: { path: hostPath },
        mountPath: "/data",
      },
    ],
  });
  await sandbox.files.writeFiles([
    {
      path: filename,
      data: content,
      mode: 644,
    },
  ]);
  console.log(
    `Wrote ${filename} in the sandbox.\nHost file: ${hostPath}/host-volume-demo.txt\n${content}Destroying the first sandbox...`,
  );

  await sandbox.kill();
} catch (err) {
  if (err instanceof SandboxException) {
    console.error(`Sandbox Error: [${err.error.code}] ${err.error.message ?? ""}`);
    console.error(`Request ID: ${err.requestId ?? "N/A"}`);
  } else {
    console.error(err);
  }
} finally {
  await sandbox?.close();
}

try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
    volumes: [
      {
        name: "host-data",
        host: { path: hostPath },
        mountPath: "/data",
      },
    ],
  });
  const readContent = await sandbox.files.readFile(filename);
  if (readContent !== content) {
    throw new Error("Host volume data was not preserved after the sandbox was destroyed.");
  }
  console.log(`Read the same content from a new sandbox: ${readContent}`);
  await sandbox.kill();
} finally {
  await sandbox?.close();
}
