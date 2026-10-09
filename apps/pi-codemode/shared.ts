import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { QuickJS } from "quickjs-wasi";

/** 加载 quickjs.wasm 并创建一个全新的 QuickJS VM */
export async function createVM(): Promise<QuickJS> {
	const wasm = await readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"));
	return QuickJS.create({ wasm });
}
