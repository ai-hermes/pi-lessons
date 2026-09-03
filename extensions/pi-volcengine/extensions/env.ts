import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function findEnvPath(startDir = process.cwd()): string | undefined {
    let dir = startDir;
    while (true) {
        const p = path.join(dir, '.env');
        if (fs.existsSync(p)) return p;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}


dotenv.config({
    path: findEnvPath(),
});
