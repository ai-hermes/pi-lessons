// 实验 2-1（QuickJS 基础 · 异步模型 · 微任务）：VM 里没有事件循环，then 回调不会自己跑，
// 要等宿主调用 executePendingJobs()。这是实验 6 和 Pi 里 drain() / stalled() 的基础。
import { createVM } from "./shared.ts";

const vm = await createVM();
const show = (label: string) => console.log(`${label.padEnd(36)} log =`, vm.dump(vm.evalCode("JSON.stringify(log)")));

vm.evalCode("globalThis.log = []");

vm.evalCode(`log.push("sync-1"); Promise.resolve().then(() => log.push("then")); log.push("sync-2");`);
show("evalCode 之后");
console.log("executePendingJobs() 执行了", vm.executePendingJobs(), "个 job");
show("executePendingJobs 之后");

vm.dispose();
