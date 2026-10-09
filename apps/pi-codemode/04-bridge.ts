// 实验 4（复刻 · bridge）：宿主（Node）往 VM 里注入一个函数。VM 调用它时，执行的其实是 Node 代码。
import type { JSValueHandle } from "quickjs-wasi";
import { createVM } from "./shared.ts";

const vm = await createVM();

// newFunction 创建一个“宿主函数”：参数是 VM 值的句柄，需要用 toString()/toNumber() 取出来
const bridge = vm.newFunction("bridge", (kind: JSValueHandle, payload: JSValueHandle) => {
	console.log(`[Node 侧] 收到 bridge(${kind.toString()}, ${payload.toString()})`);
	return vm.newString("Node 的回复");
});

// 方式 A：直接挂到全局上 —— 脚本能看见、能随便调
vm.global.setProp("bridge", bridge);
console.log("脚本拿到返回值:", vm.dump(vm.evalCode(`bridge("call", JSON.stringify({ q: 1 }))`)));

// 注意只能传原始值：对象要先 JSON.stringify，到 Node 侧再 JSON.parse。
// 这就是 Pi 里 “只有 JSON 能穿过 bridge” 的原因。
console.log("typeof bridge in VM =", vm.dump(vm.evalCode("typeof bridge")));

vm.dispose();
