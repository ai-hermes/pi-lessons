import { ConnectionConfig, Sandbox, SandboxException } from "@alibaba-group/opensandbox";
import { opensandboxConnectionOptions } from "../config";

function sleepN(second: number) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(null)
    }, second * 1_000)
  })
}

const config = new ConnectionConfig({
  ...opensandboxConnectionOptions,
  // protocol: "https",
  // requestTimeoutSeconds: 60,
  useServerProxy: true,
  //   debug: true,
});

try {
  const sandbox = await Sandbox.create({
    connectionConfig: config,
    image: "crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2",
    timeoutSeconds: 10 * 60,
  });

  const execution1 = await sandbox.commands.run("echo 'Hello Sandbox!'");
  console.log(execution1.logs.stdout[0]?.text);

  await sandbox.files.writeFiles(
    [
      {
        path: "/tmp/hello.sh",
        data: "echo \"Hello $1\"\necho '2 + 2 =' $((2 + 2))",
        mode: 755,
      }
    ]
  )
  const content = await sandbox.files.readFile("/tmp/hello.sh")
  console.log(`Content: ${content}`)


  const execution2 =  await sandbox.commands.run("sh /tmp/hello.sh OpenSandbox")
  console.log(execution2.logs.stdout.map(({ text }) => text).join("\n"));
  await sleepN(60)
  // Optional but recommended: terminate the remote instance when you are done.
  await sandbox.kill();
  await sandbox.close();
} catch (err) {
  if (err instanceof SandboxException) {
    console.error(
      `Sandbox Error: [${err.error.code}] ${err.error.message ?? ""}`,
    );
    console.error(`Request ID: ${err.requestId ?? "N/A"}`);
  } else {
    console.error(err);
  }
}
