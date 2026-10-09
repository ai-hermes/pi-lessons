// 实验 2-3（QuickJS 基础 · 异步模型 · 卡死）：VM 里没有定时器和 I/O，一个没人 resolve 的 Promise 会永远挂着。
// Pi 的 stalled() 检测的就是这类“再也醒不过来”的脚本。
import { createVM } from "./shared.ts";

const vm = await createVM();
const show = (label: string) => console.log(`${label.padEnd(36)} log =`, vm.dump(vm.evalCode("JSON.stringify(log)")));
const STATE = ["pending", "fulfilled", "rejected"] as const;

vm.evalCode("globalThis.log = []");
console.log("typeof setTimeout =", vm.dump(vm.evalCode("typeof setTimeout")));

const stuck = vm.evalCode(`(async () => { await new Promise(() => {}); log.push("永远到不了"); })()`);
vm.executePendingJobs();
console.log("跑完所有 job 后 Promise 状态:", STATE[stuck.promiseState]);
show("跑完所有 job 之后");

vm.dispose();
