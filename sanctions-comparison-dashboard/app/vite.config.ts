import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

// A standalone app: no API, no database, no imports from the other apps.
export default defineConfig({
  plugins: [react(), tailwindcss() as PluginOption],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "./src") }],
    dedupe: ["react", "react-dom"],
  },
  server: { port: 5190 },
  preview: { port: 5190 },
});
