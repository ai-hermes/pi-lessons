import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertInside, resolvePaths } from "@server/config";

describe("managed paths", () => {
  it("accepts descendants and rejects the root or traversal", () => {
    const root = "/tmp/pi-chat-test";
    expect(assertInside(root, join(root, "child"))).toBe(join(root, "child"));
    expect(() => assertInside(root, root)).toThrow(/outside managed directory/);
    expect(() => assertInside(root, join(root, "..", "escape"))).toThrow(/outside managed directory/);
  });

  it("derives all stores from an explicit root", () => {
    const paths = resolvePaths("/tmp/pi-chat-custom");
    expect(paths.appSettings).toBe("/tmp/pi-chat-custom/app-settings.json");
    expect(paths.sessions).toBe("/tmp/pi-chat-custom/sessions");
    expect(paths.workspaces).toBe("/tmp/pi-chat-custom/workspaces");
  });
});
