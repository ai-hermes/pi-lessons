// 实验 2（QuickJS 基础 · 异步模型）：VM 里没有事件循环，Promise 什么时候往下走，完全由宿主决定。
// 这是实验 6（复刻异步工具调用）和 Pi 里 drain() / stalled() 的基础。
import type { JSValueHandle } from "quickjs-wasi";
import { createVM } from "./shared.ts";

const vm = await createVM();
const show = (label: string) => console.log(`  ${label.padEnd(36)} log =`, vm.dump(vm.evalCode("JSON.stringify(log)")));
const STATE = ["pending", "fulfilled", "rejected"] as const;

vm.evalCode("globalThis.log = []");

console.log("A. 微任务不会自己跑：then 回调要等宿主调用 executePendingJobs()");
vm.evalCode(`log.push("sync-1"); Promise.resolve().then(() => log.push("then")); log.push("sync-2");`);
show("evalCode 之后");
console.log("  executePendingJobs() 执行了", vm.executePendingJobs(), "个 job");
show("executePendingJobs 之后");

console.log("\nB. async/await：await 之后的代码就是微任务，一次 executePendingJobs 会把链条跑完");
vm.evalCode("log.length = 0");
const p = vm.evalCode(`(async () => {
	log.push("start");
	await null; log.push("after await 1");
	await null; log.push("after await 2");
	return 42;
})()`);
show("调用 async 函数之后");
console.log("  Promise 状态:", STATE[p.promiseState]);
console.log("  executePendingJobs() 执行了", vm.executePendingJobs(), "个 job");
show("executePendingJobs 之后");
const pr = await vm.resolvePromise(p);
console.log("  Promise 状态:", STATE[p.promiseState], "结果:", "value" in pr ? vm.dump(pr.value) : vm.dump(pr.error));

console.log("\nC. 没有定时器和 I/O：一个没人 resolve 的 Promise 会永远挂着");
console.log("  typeof setTimeout =", vm.dump(vm.evalCode("typeof setTimeout")));
const stuck = vm.evalCode(`(async () => { await new Promise(() => {}); log.push("永远到不了"); })()`);
vm.executePendingJobs();
console.log("  跑完所有 job 后状态:", STATE[stuck.promiseState], "→ Pi 的 stalled() 检测的就是这类“再也醒不过来”的脚本");

console.log("\nD/E. 宿主创建 Promise 交给 VM：Node 的定时器到点后 resolve / reject，再推进微任务");
vm.evalCode("log.length = 0");
vm.global.setProp(
	"sleep",
	vm.newFunction("sleep", (ms: JSValueHandle) => {
		const deferred = vm.newPromise(); // VM 里的 Promise，resolve/reject 由宿主掌握
		const n = ms.toNumber();
		setTimeout(() => {
			console.log(`  [Node] ${n}ms 到了，resolve`);
			deferred.resolve(vm.newString(`slept ${n}ms`));
			show("resolve 之后、executePendingJobs 之前");
			vm.executePendingJobs(); // 不调用这一步，脚本不会继续
			show("executePendingJobs 之后");
		}, n);
		return deferred.handle;
	}),
);
const script = vm.evalCode(`(async () => {
	log.push("before sleep");
	const r = await sleep(100);
	log.push(r);
	try { await failLater(); } catch (e) { log.push("caught: " + e.message); }
	return "done";
})()`);

// E. 宿主 reject：VM 里的 try/catch 能接住（下面 [Node] reject 那几行）
vm.global.setProp(
	"failLater",
	vm.newFunction("failLater", () => {
		const deferred = vm.newPromise();
		setTimeout(() => {
			console.log("  [Node] reject");
			deferred.reject(vm.newError("tool failed"));
			vm.executePendingJobs();
			show("reject + executePendingJobs 之后");
		}, 50);
		return deferred.handle;
	}),
);

vm.executePendingJobs();
show("脚本同步部分跑完（停在 await sleep）");

// resolvePromise：在 Node 侧 await VM 里的 Promise
const outcome = await vm.resolvePromise(script);
console.log("\n  resolvePromise(script) =>", "value" in outcome ? vm.dump(outcome.value) : vm.dump(outcome.error));
vm.dispose();
