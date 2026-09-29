import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions, sleepN } from "./config";

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  useServerProxy: true,
});

let sandbox: Sandbox | null = null;
try {
  sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
  });

  const execution1 = await sandbox.commands.run("echo 'Hello Sandbox!'");
  console.log(execution1.logs.stdout[0]?.text);
  //   await sleepN(20);

  await sandbox.files.writeFiles([
    {
      path: "/tmp/hello.sh",
      data: "echo \"Hello $1\"\necho '2 + 2 =' $((2 + 2))",
      mode: 755,
    },
  ]);

  const content = await sandbox.files.readFile("/tmp/hello.sh");
  console.log(`Content: ${content}`);

  const execution2 = await sandbox.commands.run("sh /tmp/hello.sh OpenSandbox");
  /*
    [
        "Hello OpenSandbox",
        "2 + 2 = 4"
    ]
  */
  console.log(execution2.logs.stdout.map((item) => item.text).join("\n"));

  await sandbox.kill();
} finally {
  await sandbox?.close();
}
