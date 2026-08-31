import { join, resolve, relative, isAbsolute } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
/*
$HOME/.pi/agent/pi-chat
├── app-settings.json
├── exports
├── records
│   ├── 02583c3c-3baa-4285-917f-5218412322c2.json
├── sessions
│   ├── 2026-08-26T00-38-47-651Z_02583c3c-3baa-4285-917f-5218412322c2.jsonl
└── workspaces
    ├── 02583c3c-3baa-4285-917f-5218412322c2
    └── README.md
*/
export interface GlobalConfig {
    rootDir: string;
    recordsDir: string;
    sessionsDir: string;
    workspacesDir: string;
}

export function getGlobalConfig(rootDir = process.env.PI_CHAT_ROOT_DIR): GlobalConfig {
    const resolvedRootDir = rootDir ?? join(getAgentDir(), 'pi-chat');
    return {
        rootDir: resolvedRootDir,
        recordsDir: join(resolvedRootDir, 'records'),
        sessionsDir: join(resolvedRootDir, 'sessions'),
        workspacesDir: join(resolvedRootDir, 'workspaces'),
    };
}


export async function ensureDir(paths: string[]) {
    return Promise.all(
        paths.map(path => 
            mkdir(path, { recursive: true })
        )
    );
}

export function assertInside(parentDir: string, candidateDir: string) {
    const safeRootDir = resolve(parentDir);
    const safeCandidateDir = resolve(candidateDir);
    const child = relative(safeRootDir, safeCandidateDir);
    if (
        !child || child == '' ||  // candidateDir equals rootDir
        child.startsWith('..') || // candicateDir is outside rootDir
        isAbsolute(child) // absolute path is not allowed
    ) {
        throw new Error(`Directory ${candidateDir} is not inside ${parentDir}`);
    }
    return safeCandidateDir;
}