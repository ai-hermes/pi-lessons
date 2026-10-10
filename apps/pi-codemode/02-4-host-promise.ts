// 实验 2-4（QuickJS 基础 · 异步模型 · 宿主 Promise）：宿主创建 Promise 交给 VM，
// Node 的定时器到点后 resolve / reject，再调用 executePendingJobs() 推进脚本。这就是实验 6 异步工具调用的雏形。
import type { JSValueHandle } from "quickjs-wasi";
import { createVM } from "./shared.ts";

const vm = await createVM();
const show = (label: string) => console.log(`${label.padEnd(36)} log =`, vm.dump(vm.evalCode("JSON.stringify(log)")));

vm.evalCode("globalThis.log = []");

// 宿主 resolve：sleep(ms) 返回一个由 Node 定时器 resolve 的 Promise
vm.global.setProp(
	"sleep",
	vm.newFunction("sleep", (ms: JSValueHandle) => {
		const deferred = vm.newPromise(); // VM 里的 Promise，resolve/reject 由宿主掌握
		const n = ms.toNumber();
		setTimeout(() => {
			console.log(`[Node] ${n}ms 到了，resolve`);
			deferred.resolve(vm.newString(`slept ${n}ms`));
			show("resolve 之后、executePendingJobs 之前");
			vm.executePendingJobs(); // 不调用这一步，脚本不会继续
			show("executePendingJobs 之后");
		}, n);
		return deferred.handle;
	}),
);

// 宿主 reject：VM 里的 try/catch 能接住
vm.global.setProp(
	"failLater",
	vm.newFunction("failLater", () => {
		const deferred = vm.newPromise();
		setTimeout(() => {
			console.log("[Node] reject");
			deferred.reject(vm.newError("tool failed"));
			vm.executePendingJobs();
			show("reject + executePendingJobs 之后");
		}, 50);
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

// vm.executePendingJobs();
show("脚本同步部分跑完（停在 await sleep）");

// resolvePromise：在 Node 侧 await VM 里的 Promise
const outcome = await vm.resolvePromise(script);
console.log("resolvePromise(script) =>", "value" in outcome ? vm.dump(outcome.value) : vm.dump(outcome.error));
vm.dispose();
