// 实验 1（QuickJS 基础 · 沙箱）：QuickJS 是一个“空白”的 JS 引擎，跑在 wasm 里，和 Node 完全隔离。
import { createVM } from "./shared.ts";

const vm = await createVM();

// 1) 能执行普通 JS，dump() 把 VM 里的值转成 Node 里的值
console.log("1+2 =", vm.dump(vm.evalCode("1 + 2")));
console.log("对象 =", vm.dump(vm.evalCode("({ a: [1, 2], b: 'x' })")));

// 2) VM 里只有语言内置对象，没有 console / fetch / setTimeout / require / process
const probe = `JSON.stringify({
  console: typeof console,
  fetch: typeof fetch,
  setTimeout: typeof setTimeout,
  require: typeof require,
  process: typeof process,
  tools: typeof tools,
})`;
console.log("VM 里的全局对象 =", vm.dump(vm.evalCode(probe)));

vm.dispose();
