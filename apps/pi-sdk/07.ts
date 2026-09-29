// /**
//  * 模块 5 / Ep5.1
//  * 给 prompt 传入图片内容，让模型做视觉描述。
//  *
//  * 用法:
//  *   pnpm example:image-input -- ./assets/sample.png
//  */

// import { readFile } from "node:fs/promises";
// import { extname } from "node:path";
// import { createAgentSession } from "@earendil-works/pi-coding-agent";
// import { attachTextStream } from "../shared/stream-text.js";

// function toMediaType(path: string): string {
//   const ext = extname(path).toLowerCase();
//   switch (ext) {
//     case ".png":
//       return "image/png";
//     case ".jpg":
//     case ".jpeg":
//       return "image/jpeg";
//     case ".webp":
//       return "image/webp";
//     default:
//       throw new Error(`Unsupported image type: ${ext}`);
//   }
// }

// const imagePath = process.argv[2];
// if (!imagePath) {
//   throw new Error("Missing image path. Usage: pnpm example:image-input -- ./path/to/image.png");
// }

// const imageBuffer = await readFile(imagePath);
// const mediaType = toMediaType(imagePath);
// const data = imageBuffer.toString("base64");

// const { session } = await createAgentSession();

// try {
//   const unsubscribe = attachTextStream(session);
//   await session.prompt("Describe this image in Chinese with 3 bullet points.", {
//     images: [
//       {
//         type: "image",
//         mimeType: mediaType,
//         data,
//       },
//     ],
//   });
//   unsubscribe();
//   process.stdout.write("\n");
// } finally {
//   session.dispose();
// }
