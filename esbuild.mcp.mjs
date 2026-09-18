import esbuild from "esbuild";
import path from "path";

// The retrieval code imports "obsidian" for requestUrl; point that at a fetch-based shim
const obsidianShim = {
  name: "obsidian-shim",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve("mcp/obsidian-shim.ts") }));
  },
};

await esbuild.build({
  entryPoints: ["mcp/server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "mcp-server.js",
  plugins: [obsidianShim],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
