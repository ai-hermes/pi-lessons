import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config.ts";

const storageClass = process.env.S3_STORAGE_CLASS?.trim() || "oss-aliyun-s3";
const claimName = process.env.S3_PVC_NAME?.trim() || "opensandbox-object-data";
const filename = "/data/s3-persistence-demo.txt";
const content = `Written at ${new Date().toISOString()}\n`;

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  // Dynamic provisioning and the first object-storage mount can take longer.
  requestTimeoutSeconds: 180,
  useServerProxy: true,
});

async function createSandbox() {
  return await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
    volumes: [
      {
        name: "object-data",
        pvc: {
          claimName,
          createIfNotExists: true,
          deleteOnSandboxTermination: false,
          storageClass,
          storage: "1Gi",
          accessModes: ["ReadWriteMany"],
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

console.log(`Using StorageClass "${storageClass}" and PVC "${claimName}".`);

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
    throw new Error("Object-storage PVC data was not preserved after the sandbox was destroyed.");
  }
  console.log(`Read the same content from a new sandbox: ${persisted}`);
} finally {
  await destroy(reader);
}
