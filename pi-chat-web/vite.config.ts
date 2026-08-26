import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { aliases } from "./aliases";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
  server: { host: "127.0.0.1", port: 4327, strictPort: true, proxy: { "/api": "http://127.0.0.1:4328" } },
});
