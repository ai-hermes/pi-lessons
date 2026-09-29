import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions, sleepN } from "./config";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  useServerProxy: true,
});

let sandbox: Sandbox | null = null;
const filename = "/data/persistence-demo.txt";
const content = `Written at ${new Date().toISOString()}\n`;
try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
    volumes: [
      {
        name: "object-data",
        pvc: {
          claimName: "oss-object-data",
          createIfNotExists: true,
          deleteOnSandboxTermination: false,
          storageClass: "oss-aliyun-s3",
          storage: "1Gi",
          accessModes: ["ReadWriteMany"]
        },
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

  await sandbox.kill();
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
        name: "object-data",
        pvc: {
          claimName: "oss-object-data",
          createIfNotExists: true,
          deleteOnSandboxTermination: false,
          storageClass: "oss-aliyun-s3",
          storage: "1Gi",
          accessModes: ["ReadWriteMany"]
        },
        mountPath: "/data",
      },
    ],
  });

  const persisted = await sandbox.files.readFile(filename);
  if (persisted !== content) {
    throw new Error("PVC data was not preserved after the sandbox destoryed");
  }
  console.log(`Read the same content from new sandbox: ${persisted}`);

  await sandbox.kill();
} finally {
  await sandbox?.close();
}
