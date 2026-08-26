import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { aliases } from "./aliases";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: aliases },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});
