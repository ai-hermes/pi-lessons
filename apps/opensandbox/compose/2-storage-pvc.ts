import { ConnectionConfig, Sandbox, SandboxException } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config";
let sandbox: Sandbox | null = null;
const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  useServerProxy: true,
});
const filename = "/data/persistence-demo.txt";
const content = `Written at ${new Date().toISOString()}\n`;
try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
    volumes: [
      {
        name: "tutorial-data",
        pvc: {
          claimName: "opensandbox-tutorial-data",
          createIfNotExists: true,
          deleteOnSandboxTermination: false,
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
        name: "tutorial-data",
        pvc: {
          claimName: "opensandbox-tutorial-data",
          createIfNotExists: true,
          deleteOnSandboxTermination: false,
        },
        mountPath: "/data",
      },
    ],
  });
  const readContent = await sandbox.files.readFile(filename);
  if (readContent !== content) {
    throw new Error("PVC data was not preserved after the sandbox was destroyed.");
  }
  console.log(`Read the same content from a new sandbox: ${readContent}`);
  await sandbox.kill();
} finally {
  await sandbox?.close();
}
