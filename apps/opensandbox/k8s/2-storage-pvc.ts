import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config";

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
        name: "tutorial-data",
        pvc: {
          claimName: "opensandbox-tutorial-data",
          createIfNotExists: true,
          // 保留卷，下一次创建同名挂载时仍可读取其中的数据。
          deleteOnSandboxTermination: false,
        },
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

const filename = "/data/persistence-demo.txt";
const content = `Written at ${new Date().toISOString()}\n`;

const writer = await createSandbox();
try {
  await writer.files.writeFiles([{ path: filename, data: content, mode: 644 }]);
  console.log(`Wrote ${filename}:\n${content}Destroying the first sandbox...`);
} finally {
  await destroy(writer);
}

const reader = await createSandbox();
try {
  const persisted = await reader.files.readFile(filename);
  if (persisted !== content) {
    throw new Error("PVC data was not preserved after the sandbox was destroyed.");
  }
  console.log(`Read the same content from a new sandbox: ${persisted}`);
} finally {
  await destroy(reader);
}
