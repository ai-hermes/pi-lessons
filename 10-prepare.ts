/*
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";

// 适合一次性、单一会话的场景
// 返回 { session, extensionsResult, modelFallbackMessage? }
// session 提供 prompt()、subscribe()、dispose() 等核心交互方法
// 会话一旦创建，无法替换——不能中途 /new、/resume、/fork
// 适合嵌入脚本、自动化管道、单次问答等简单场景
const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime
});

await session.prompt("Hello");
session.dispose();

*/


import {
    CreateAgentSessionRuntimeFactory, createAgentSessionServices, createAgentSessionFromServices,
    createAgentSessionRuntime, getAgentDir, SessionManager
} from '@earendil-works/pi-coding-agent';

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd });
    return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
    };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(process.cwd()),
});
await runtime.session.prompt("Hello");

// 会话操作
// await runtime.newSession();           // 新建会话
// await runtime.switchSession(path);    // 恢复已有会话
// await runtime.fork("entry-id");       // 从某条消息分叉
// 返回 AgentSessionRuntime 对象，持有当前活动会话
// 支持 newSession()、switchSession()、fork() 等会话替换 API
// 每次替换会重建 cwd 绑定的运行时状态（重新创建 services、扩展、工具等）
// 需要传入一个 CreateAgentSessionRuntimeFactory 工厂函数，用于按需构造新的运行时上下文
// 适合构建自定义 TUI、需要多会话管理的应用、或复用 Pi 内置运行模式（InteractiveMode、runPrintMode、runRpcMode）
