import { defineConfig } from "eslint/config";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default defineConfig([
  { ignores: ["main.js", "mcp-server.js", "node_modules/", "demo_vault/"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "esbuild.mcp.mjs", "version-bump.mjs"],
        },
      },
    },
    rules: {
      // Passing a list replaces the defaults, so extend them with this plugin's own names
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: [...DEFAULT_BRANDS, "Google AI Studio", "Qdrant", "LM Studio", "Ollama", "Memex"],
        acronyms: [...DEFAULT_ACRONYMS, "RAG"],
        // URLs and model IDs are identifiers, not prose
        ignoreRegex: ["https?://", "aistudio\\.google\\.com", "^[\\w.-]+/[\\w.-]+$", "\\b(gemini|text-embedding)-[\\w.-]+"],
      }],
    },
  },
  {
    // TypeScript already reports undefined names, and this core rule can't see type-only
    // globals such as AsyncGenerator (typescript-eslint recommends turning it off)
    files: ["**/*.ts"],
    rules: { "no-undef": "off" },
  },
  {
    // Not plugin code: the MCP server and build scripts run in Node, never inside Obsidian
    files: ["mcp/**/*.ts", "*.mjs"],
    languageOptions: { globals: globals.node },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/rule-custom-message": "off", // no-console: the MCP server logs to stderr by design
      "no-restricted-globals": "off", // fetch is the right HTTP client outside Obsidian
    },
  },
]);
