import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GlobalQueueSettings, QueueMode } from "@shared/types";

export interface GlobalToolSettings {
  defaultEnabled: true;
  overrides: Record<string, boolean>;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
}

export interface ConversationToolSettings {
  overrides: Record<string, boolean>;
}

const DEFAULT_SETTINGS: GlobalToolSettings = {
  defaultEnabled: true,
  overrides: {},
  steeringMode: "all",
  followUpMode: "all",
};

export class ToolSettingsStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<GlobalToolSettings> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as {
        overrides?: unknown;
        steeringMode?: unknown;
        followUpMode?: unknown;
      };
      return {
        defaultEnabled: true,
        overrides: booleanRecord(value.overrides),
        steeringMode: queueMode(value.steeringMode) ?? DEFAULT_SETTINGS.steeringMode,
        followUpMode: queueMode(value.followUpMode) ?? DEFAULT_SETTINGS.followUpMode,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
      throw error;
    }
  }

  async update(name: string, enabled: boolean): Promise<GlobalToolSettings> {
    let result: GlobalToolSettings | undefined;
    const write = this.writes.then(async () => {
      const current = await this.read();
      current.overrides[name] = enabled;
      await this.write(current);
      result = current;
    });
    this.writes = write.catch(() => undefined);
    await write;
    return result!;
  }

  async updateQueue(patch: Partial<GlobalQueueSettings>): Promise<GlobalToolSettings> {
    let result: GlobalToolSettings | undefined;
    const write = this.writes.then(async () => {
      const current = await this.read();
      if (patch.steeringMode) current.steeringMode = patch.steeringMode;
      if (patch.followUpMode) current.followUpMode = patch.followUpMode;
      await this.write(current);
      result = current;
    });
    this.writes = write.catch(() => undefined);
    await write;
    return result!;
  }

  private async write(settings: GlobalToolSettings): Promise<void> {
    const temporary = join(dirname(this.path), `.app-settings-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

export function conversationToolSettings(value: unknown): ConversationToolSettings {
  const settings = value as { overrides?: unknown } | undefined;
  return { overrides: booleanRecord(settings?.overrides) };
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
}

function queueMode(value: unknown): QueueMode | undefined {
  return value === "all" || value === "one-at-a-time" ? value : undefined;
}
