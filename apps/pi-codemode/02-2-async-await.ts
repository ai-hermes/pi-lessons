// 实验 2-2（QuickJS 基础 · 异步模型 · async/await）：await 之后的代码就是微任务，
// 一次 executePendingJobs() 会把整条链跑完。
import { createVM } from "./shared.ts";

const vm = await createVM();
const show = (label: string) => console.log(`${label.padEnd(36)} log =`, vm.dump(vm.evalCode("JSON.stringify(log)")));
const STATE = ["pending", "fulfilled", "rejected"] as const;

vm.evalCode("globalThis.log = []");
const p = vm.evalCode(`(async () => {
	log.push("start");
	await null; log.push("after await 1");
	await null; log.push("after await 2");
	return 42;
})()`);
show("调用 async 函数之后");
console.log("Promise 状态:", STATE[p.promiseState]);
console.log("executePendingJobs() 执行了", vm.executePendingJobs(), "个 job");
show("executePendingJobs 之后");
const pr = await vm.resolvePromise(p);
console.log("Promise 状态:", STATE[p.promiseState], "结果:", "value" in pr ? vm.dump(pr.value) : vm.dump(pr.error));

vm.dispose();
