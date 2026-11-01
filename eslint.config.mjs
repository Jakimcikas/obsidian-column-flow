// Same rules Obsidian's plugin directory runs on submission.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/", "parse.test.ts", "esbuild.config.mjs", "version-bump.mjs"] },
	...obsidianmd.configs.recommended,
	{ languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } } } },
]);
