import { defineConfig } from "vite";
import { resolve } from "path";

/**
 * Build dedicado do CONTENT SCRIPT.
 *
 * Content scripts MV3 NÃO são módulos ES — não suportam `import`. Por isso este
 * build gera um único arquivo IIFE auto-contido (format: "iife" +
 * inlineDynamicImports), sem chunks compartilhados. O build principal
 * (vite.config.ts) cuida do background (type: module) e das páginas HTML.
 *
 * emptyOutDir: false → roda DEPOIS do build principal e só adiciona o content,
 * sem apagar o resto.
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: { content: resolve(__dirname, "src/content/index.ts") },
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "content/index.js",
        assetFileNames: "content/[name].[ext]",
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
