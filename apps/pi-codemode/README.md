# pi-codemode

用 TypeScript 拆解 Pi 的 codemode：QuickJS（wasm）沙箱 + prelude 注入 + bridge 异步工具调用。

```bash
pnpm install
pnpm --filter pi-codemode run 01   # 01, 02-1 ~ 02-4, 03 ~ 06
pnpm --filter pi-codemode typecheck
```

| 实验 | 文件 | 内容 |
| --- | --- | --- |
| 1 | `01-hello.ts` | QuickJS 基础：空白沙箱，没有 console / fetch / setTimeout |
| 2-1 | `02-1-microtask.ts` | 异步模型：微任务需宿主 `executePendingJobs()` 推进 |
| 2-2 | `02-2-async-await.ts` | 异步模型：`await` 之后的代码就是微任务 |
| 2-3 | `02-3-stalled.ts` | 异步模型：没人 resolve 的 Promise 永远挂着（`stalled()`） |
| 2-4 | `02-4-host-promise.ts` | 异步模型：宿主 resolve / reject 交给 VM 的 Promise |
| 3 | `03-pi-codemode.ts` | 使用 `@earendil-works/pi-codemode` 的 `CodemodeSandbox` |
| 4 | `04-bridge.ts` | 复刻 bridge：`newFunction` 注入宿主函数 |
| 5 | `05-mini-prelude.ts` | 复刻 prelude：闭包持有 bridge，注入 tools / console / store |
| 6 | `06-async-bridge.ts` | 复刻异步工具调用：pending 表 + settle + drain |

图示见 `assets/`。注意 prelude / 用户脚本是以字符串形式在 QuickJS 里执行的 **JS**，TS 只用于宿主侧。
