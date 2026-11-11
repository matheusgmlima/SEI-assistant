import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // NOTA: o content script tem build próprio (vite.content.config.ts) em
        // formato IIFE, pois content scripts MV3 não suportam `import`.
        background: resolve(__dirname, "src/background/index.ts"),
        sidebar: resolve(__dirname, "sidebar.html"),
        report: resolve(__dirname, "report.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        correcoes: resolve(__dirname, "correcoes.html"),
      },
      output: {
        entryFileNames: "[name]/index.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@shared": resolve(__dirname, "../shared/src"),
    },
  },
});
