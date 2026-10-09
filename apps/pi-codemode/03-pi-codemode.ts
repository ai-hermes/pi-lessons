// 实验 3（探索 Pi）：先当“使用者”探索 Pi 的 codemode 包（真实的 prelude + Worker + host）。
// 这里看到的现象（全局对象、bridge 不可见、Proxy 报错、store、JSON 限制），
// 会在实验 4~6 里逐个手写复刻。
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

const sandbox = new CodemodeSandbox({
	// 对应 tools.xxx —— 原名里有 "-"，jsName 会变成 mcp__dev_radius__search
	tools: [
		{
			name: "mcp__dev-radius__search",
			description: "Search dev radius",
			execute: async (args: any) => {
				console.log("  [Node] tool 被调用，args =", args);
				await new Promise((r) => setTimeout(r, 100));
				return { content: [{ type: "text", text: `result for ${args.query}` }], isError: false };
			},
		},
	],
	// 对应 searchTools / describeTool 这类“顶层全局函数”（Pi 的 discovery globals 就是这样注入的）
	globals: [
		{
			name: "searchTools",
			spread: true, // execute 收到的是整个参数数组
			execute: async (args: unknown) => {
				console.log("  [Node] global searchTools 被调用，args =", args);
				return [{ name: "mcp__dev_radius__search", description: "declare function ..." }];
			},
		},
	],
});

const code = `
// —— 看看 prelude 注入了哪些全局对象 ——
console.log("globals:", Object.keys(globalThis).filter(k => !["globalThis"].includes(k)).join(", "));
console.log("typeof bridge:", typeof bridge);
console.log("ALL_TOOLS:", ALL_TOOLS);

// —— 同一个工具两种访问方式 ——
console.log("同一个函数?", tools.mcp__dev_radius__search === tools["mcp__dev-radius__search"]);

// —— 看看工具函数本身的源码：就是 prelude 里 caller() 返回的箭头函数 ——
// 所有工具和 searchTools 共用同一份代码，区别只在闭包捕获的 kind / name / spread
const f = tools.mcp__dev_radius__search;
console.log("tools.mcp__dev_radius__search.toString():\\n" + f.toString());
console.log("name / length:", JSON.stringify({ name: f.name, length: f.length }));
console.log("和 searchTools 源码相同?", f.toString() === searchTools.toString());
console.log("store.toString() 开头:", store.toString().split("\\n")[0], "…（具名函数，不经过 bridge）");

// —— 拼错名字：guard Proxy 给出提示 ——
try { tools.mcp_dev_radius_search } catch (e) { console.log("拼错:", e.message) }

// —— 调用 global 和 tool ——
const hits = await searchTools("radius", { limit: 3 });
const r = await tools.mcp__dev_radius__search({ query: "codemode" });
console.log("hits:", hits, "result:", r);

// —— store：同步，结束时随 done 一起交给宿主 ——
console.log("load 上次的值:", load("lastQuery"));
store("lastQuery", "codemode");

// —— 只有 JSON 能过 bridge ——
try { await tools.mcp__dev_radius__search({ fn: () => 1, big: 1n }) } catch (e) { console.log("传 BigInt:", e.message) }

return "done";
`;

const result = await sandbox.execute(code, { store: { lastQuery: "上一次运行存的值" } });
await sandbox.close();
console.log("\n===== CodemodeResult =====");
console.log(JSON.stringify(result, null, 2));
