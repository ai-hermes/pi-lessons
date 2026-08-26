import { describe, expect, it, vi } from "vitest";
import { EventBuffer } from "@server/events";

describe("EventBuffer", () => {
  it("publishes, replays, and detects stale cursors", () => {
    const buffer = new EventBuffer(2);
    const listener = vi.fn();
    buffer.subscribe(listener);
    buffer.publish("one");
    buffer.publish("two");
    buffer.publish("three");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(buffer.replay(1).stale).toBe(false);
    expect(buffer.replay(0).events.map((event) => event.type)).toEqual(["two", "three"]);
  });
});
