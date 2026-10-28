import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions, requiredEnv } from "../config";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  requestTimeoutSeconds: 60,
  useServerProxy: true,
});

// 服务端需先创建此目录，并将其前缀加入 config.toml 的
// [storage].allowed_host_paths。
const hostPath = requiredEnv("HOST_VOLUME_PATH");
const filename = "/data/host-volume-demo.txt";
const content = `Written at ${new Date().toISOString()}\n`;

async function createSandbox() {
  return await Sandbox.create({
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
}

async function destroy(sandbox: Sandbox) {
  try {
    await sandbox.kill();
  } finally {
    await sandbox.close();
  }
}

const writer = await createSandbox();
try {
  await writer.files.writeFiles([{ path: filename, data: content, mode: 644 }]);
  console.log(
    `Wrote ${filename} in the sandbox.\nHost file: ${hostPath}/host-volume-demo.txt\n${content}Destroying the first sandbox...`,
  );
} finally {
  await destroy(writer);
}

const reader = await createSandbox();
try {
  const persisted = await reader.files.readFile(filename);
  if (persisted !== content) {
    throw new Error("Host volume data was not preserved after the sandbox was destroyed.");
  }
  console.log(`Read the same content from a new sandbox:\n${persisted}`);
} finally {
  await destroy(reader);
}
