import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const workspaceSource = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: import.meta.dirname,
  plugins: [{
    name: "strip-workspace-region-comments",
    generateBundle(_options, bundle) {
      for (const artifact of Object.values(bundle)) {
        if (artifact.type === "chunk") artifact.code = artifact.code.replace(/^\s*\/\/#(?:end)?region.*(?:\r?\n|$)/gmu, "");
      }
    }
  }],
  resolve: {
    alias: [
      { find: "@realtime/protocol/state-machines", replacement: workspaceSource("../protocol/src/state-machines.ts") },
      { find: "@realtime/protocol/validator", replacement: workspaceSource("../protocol/src/validator.ts") },
      { find: "@realtime/protocol/types", replacement: workspaceSource("../protocol/src/types.ts") },
      { find: "@realtime/protocol/constants", replacement: workspaceSource("../protocol/src/constants.ts") },
      { find: "@realtime/core", replacement: workspaceSource("../core/src/index.ts") },
      { find: "@realtime/diagnostics/browser", replacement: workspaceSource("../diagnostics/src/browser.ts") },
      { find: "@realtime/diagnostics", replacement: workspaceSource("../diagnostics/src/index.ts") },
      { find: "@realtime/protocol", replacement: workspaceSource("../protocol/src/index.ts") },
      { find: "@realtime/server-node", replacement: workspaceSource("../server-node/src/index.ts") },
      { find: "@realtime/store-postgres", replacement: workspaceSource("../store-postgres/src/index.ts") },
      { find: "@realtime/transport-reference/browser", replacement: workspaceSource("../transport-reference/src/browser.ts") },
      { find: "@realtime/transport-reference", replacement: workspaceSource("../transport-reference/src/index.ts") }
    ]
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: {
        index: "src/index.ts",
        react: "src/react.ts",
        server: "src/server-entry.ts",
        "diagnostic-io": "src/diagnostics-entry.ts",
        cli: "src/cli.ts",
        "cli-bin": "src/cli-bin.ts",
        "node-only": "src/node-only.ts"
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: { external: ["react", "react/jsx-runtime", "pg", "ws", /^node:/, /^@modelcontextprotocol\/sdk\//] },
    sourcemap: false,
    minify: true
  }
});
