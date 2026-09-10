import assert from "node:assert/strict";
import test from "node:test";

import { extractImages, extractText, resultText } from "./helper";

test("extracts text and images in source order", () => {
  const content = [
    { type: "text", text: "first" },
    { type: "image", data: "data", mimeType: "image/png" },
    { type: "text", text: "second" },
  ] as Parameters<typeof extractText>[0];

  assert.equal(extractText(content), "firstsecond");
  assert.deepEqual(extractImages(content), [
    { type: "image", data: "data", mimeType: "image/png" },
  ]);
  assert.equal(
    resultText({
      content: [
        { type: "text", text: "" },
        { type: "text", text: "next" },
      ],
    }),
    "\nnext",
  );
});
