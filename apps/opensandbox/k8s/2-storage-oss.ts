import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import {
  opensandboxConnectionOptions,
  requiredEnv,
} from "../config.ts";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  requestTimeoutSeconds: 60,
  useServerProxy: true,
});

async function createSandbox() {
  return await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
    volumes: [
      {
        name: "oss-data",
        ossfs: {
          bucket: requiredEnv("OSS_BUCKET"),
          endpoint: requiredEnv("OSS_ENDPOINT"),
          accessKeyId: requiredEnv("OSS_ACCESS_KEY_ID"),
          accessKeySecret: requiredEnv("OSS_ACCESS_KEY_SECRET"),
          version: "2.0",
        },
        mountPath: "/mnt/oss",
        subPath: "opensandbox-tutorial",
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

const path = "/mnt/oss/persistence-demo.txt";
const content = `Written through an OSSFS volume at ${new Date().toISOString()}.\n`;

const writer = await createSandbox();
try {
  await writer.files.writeFiles([{ path, data: content, mode: 644 }]);
  console.log(`Wrote ${path}:\n${content}Destroying the first sandbox...`);
} finally {
  await destroy(writer);
}

const reader = await createSandbox();
try {
  const persisted = await reader.files.readFile(path);
  if (persisted !== content) {
    throw new Error("OSSFS data was not preserved after the sandbox was destroyed.");
  }
  console.log(`Read the same content from a new sandbox: ${persisted}`);
} finally {
  await destroy(reader);
}
