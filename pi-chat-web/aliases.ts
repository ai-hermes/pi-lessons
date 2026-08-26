import path from "node:path";

export const aliases = {
  "@": path.resolve(__dirname, "./src"),
  "@server": path.resolve(__dirname, "./server"),
  "@shared": path.resolve(__dirname, "./shared"),
};
