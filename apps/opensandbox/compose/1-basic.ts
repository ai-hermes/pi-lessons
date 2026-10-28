import { ConnectionConfig, Sandbox, SandboxException } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config.ts";

try {
  const config = new ConnectionConfig({
    ...opensandboxConnectionOptions,
    useServerProxy: true,
  });
  const sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "mirror.example.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
  });
  const execution = await sandbox.commands.run("echo 'Hello Sandbox!'");
  console.log(execution.logs.stdout[0]?.text);
  await sandbox.kill();
  await sandbox.close();
} catch (err) {
  if (err instanceof SandboxException) {
    console.error(`Sandbox Error: [${err.error.code}] ${err.error.message ?? ""}`);
    console.error(`Request ID: ${err.requestId ?? "N/A"}`);
  } else {
    console.error(err);
  }
}
