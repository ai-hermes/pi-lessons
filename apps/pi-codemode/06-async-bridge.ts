// 实验 6（复刻 · 异步工具调用，基于实验 2 的异步模型 + 实验 4/5 的 bridge 与 prelude）：让 `await tools.xxx()` 成立 —— pending 表 + settle + executePendingJobs。
// VM 内没有事件循环，Promise 只能靠宿主“回调 settle + 手动跑微任务”来推进。
import type { JSValueHandle } from "quickjs-wasi";
import { createVM } from "./shared.ts";

const vm = await createVM();
const t0 = Date.now();
const log = (...xs: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(4)}ms]`, ...xs);

type ToolResult = { content: { type: "text"; text: string }[] };
type HostTool = (args: any) => Promise<ToolResult>;

// 宿主侧的“工具实现”（模拟 MCP server，200ms 后返回）
const hostTools: Record<string, HostTool> = {
	mcp__dev_radius__search: async ({ query }: { query: string }) => {
		await new Promise((r) => setTimeout(r, 200));
		return { content: [{ type: "text", text: `找到 3 条关于 ${query} 的结果` }] };
	},
};

// 注意：这段字符串是在 QuickJS 里执行的 JS
const PRELUDE = `(function (bridge) {
	"use strict";
	const pending = new Map();            // id -> { resolve, reject }
	let nextId = 1;
	const tools = Object.freeze({
		mcp__dev_radius__search: (args) => new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			bridge("call", id, "mcp__dev_radius__search", JSON.stringify(args)); // 发出去就返回，不阻塞
		}),
	});
	const console = Object.freeze({ log: (...xs) => bridge("output", 0, "text", xs.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) });
	Object.defineProperty(globalThis, "tools", { value: tools });
	Object.defineProperty(globalThis, "console", { value: console });
	return {
		settle(id, ok, payload) {                 // 宿主拿到结果后调用它
			const p = pending.get(id); pending.delete(id);
			ok ? p.resolve(JSON.parse(payload)) : p.reject(new Error(payload));
		},
		run(fn) {
			fn().then(
				(v) => bridge("done", 0, "ok", JSON.stringify(v)),
				(e) => bridge("done", 0, "error", String(e)),
			);
		},
		pendingCount: () => pending.size,
	};
})`;

let api: JSValueHandle;
const drain = () => {
	vm.executePendingJobs(); // 推进 VM 内的微任务（await 后面的代码在这里继续跑）
	const n = vm.dump(vm.callFunction(api.getProp("pendingCount"), api));
	log(`  drain 完毕，pending=${n}`);
};

const settle = (callId: number, ok: boolean, payload: string) => {
	vm.callFunction(api.getProp("settle"), api, vm.newNumber(callId), ok ? vm.true : vm.false, vm.newString(payload));
	drain();
};

const bridge = vm.newFunction(
	"bridge",
	(kind: JSValueHandle, id: JSValueHandle, name: JSValueHandle, payload: JSValueHandle) => {
		const k = kind.toString();
		if (k === "call") {
			const callId = id.toNumber();
			const toolName = name.toString();
			const args = JSON.parse(payload.toString());
			log(`[Node] 收到 call #${callId} ${toolName}(${JSON.stringify(args)})，开始异步执行`);
			hostTools[toolName](args).then(
				(value) => {
					log(`[Node] call #${callId} 完成，调用 settle(${callId})`);
					settle(callId, true, JSON.stringify(value));
				},
				(err: unknown) => settle(callId, false, String(err)),
			);
		} else if (k === "output") {
			log(`[Node] 输出: ${payload.toString()}`);
		} else if (k === "done") {
			log(`[Node] 脚本结束 ${name.toString()}: ${payload.toString()}`);
			setImmediate(() => vm.dispose()); // 不能在宿主回调内部销毁 VM
		}
		return vm.undefined;
	},
);

api = vm.callFunction(vm.evalCode(PRELUDE), vm.undefined, bridge);

// 用户脚本（Pi 也是这样包成 async 函数）
const userCode = `
	console.log("脚本开始");
	const [a, b] = await Promise.all([
		tools.mcp__dev_radius__search({ query: "codemode" }),
		tools.mcp__dev_radius__search({ query: "quickjs" }),
	]);
	console.log("两个结果都回来了:", a.content[0].text, "|", b.content[0].text);
	return { ok: true };
`;
const fn = vm.evalCode(`(async () => {${userCode}\n})`);
log("[Node] 调用 run(fn)");
vm.callFunction(api.getProp("run"), api, fn);
drain();
log("[Node] 同步部分结束，脚本此时停在 await 上，等待宿主回调");
