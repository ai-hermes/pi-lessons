// 实验 5（复刻 · prelude 闭包与全局对象注入）：模仿 Pi 的 prelude —— 不把 bridge 挂全局，而是传给一段 JS，
// 由这段 JS 在闭包里持有 bridge，再往 globalThis 上“注入”包装好的 tools / console / store。
import type { JSValueHandle } from "quickjs-wasi";
import { createVM } from "./shared.ts";

const vm = await createVM();

const bridge = vm.newFunction("bridge", (kind: JSValueHandle, a: JSValueHandle, b?: JSValueHandle) => {
	console.log(`  [Node] bridge("${kind.toString()}", ${a.toString()}, ${b?.toString()})`);
	return vm.undefined;
});

// —— 简化版 prelude（真实版见 pi-codemode 的 prelude-source.ts）——
// 注意：这段字符串是在 QuickJS 里执行的 JS，不是 TS
const PRELUDE = `(function (bridge, toolsJson, storeJson) {
	"use strict";
	// 1) 工具：每个名字生成一个函数，内部调用闭包里的 bridge
	const tools = Object.create(null);
	for (const name of JSON.parse(toolsJson)) {
		tools[name] = (args) => bridge("call", name, JSON.stringify(args));
	}
	Object.freeze(tools);

	// 2) console：VM 本来没有，这里自己造一个，输出也走 bridge
	const console = Object.freeze({ log: (...xs) => bridge("output", "text", xs.join(" ")) });

	// 3) store/load：纯 VM 内的 Map，不经过 bridge
	const stored = new Map(Object.entries(JSON.parse(storeJson)));
	const store = (k, v) => { stored.set(k, JSON.stringify(v)); };
	const load = (k) => stored.has(k) ? JSON.parse(stored.get(k)) : undefined;

	// 4) 注入全局：defineProperty 默认 writable/configurable = false，脚本改不了也删不掉
	Object.defineProperty(globalThis, "tools", { value: tools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });
})`;

console.log("1. 执行 prelude，把 bridge 当参数传进去（不挂全局）");
vm.callFunction(
	vm.evalCode(PRELUDE, "prelude.js"),
	vm.undefined,
	bridge,
	vm.newString(JSON.stringify(["mcp__dev_radius__search", "read"])),
	// store 快照是 key -> JSON 文本（和 Pi 的 serializeStore 一致）
	vm.newString(JSON.stringify({ lastQuery: JSON.stringify("hello") })),
);

const run = (label: string, code: string) => {
	try {
		console.log(label, "=>", vm.dump(vm.evalCode(code)));
	} catch (e) {
		console.log(label, "=> 抛错:", (e as Error).message);
	}
};

console.log("\n2. 用户脚本看到的全局对象");
run("typeof bridge", "typeof bridge"); // undefined：脚本碰不到 bridge
run("Object.keys(tools)", "Object.keys(tools)");
run("load('lastQuery')", "load('lastQuery')");

console.log("\n3. 用户脚本调用注入的函数");
run("tools.mcp__dev_radius__search(...)", `tools.mcp__dev_radius__search({ query: "codemode" })`);
run("console.log(...)", `console.log("hi", 42)`);

console.log("\n4. 尝试破坏注入的全局对象（strict 模式下会抛错）");
run("覆盖 tools", `"use strict"; tools = {}`);
run("给 tools 加成员", `"use strict"; tools.evil = () => 1`);
run("删除 console", `"use strict"; delete globalThis.console`);

vm.dispose();
