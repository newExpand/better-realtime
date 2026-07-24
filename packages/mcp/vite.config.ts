import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: {
        index: "src/index.ts",
        bin: "src/bin.ts",
        "node-runtime": "src/node-runtime.ts"
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      external: ["better-realtime", "better-realtime/diagnostics", /^node:/, /^@modelcontextprotocol\/sdk\//]
    },
    sourcemap: false,
    minify: true
  }
});
