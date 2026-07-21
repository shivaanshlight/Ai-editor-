// Single-file build: bundle the Next.js React app into ONE self-contained
// public/index.html (what server.js serves as the zero-build frontend). Reuses
// web/'s Tailwind + PostCSS. next/font is shimmed (fonts are loaded via a
// Google Fonts <link> in vite-index.html instead).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dir,
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      "@": dir,
      "next/font/google": path.resolve(dir, "vite-next-font-shim.ts"),
    },
  },
  build: {
    outDir: path.resolve(dir, "vite-dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: { input: path.resolve(dir, "vite-index.html") },
  },
});
