// End-to-end tests in a real, sandboxed Obsidian (downloaded into .obsidian-cache). Run: npm run test:e2e
import * as path from "path";

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/specs/**/*.e2e.ts"],
	maxInstances: 1,
	capabilities: [{
		browserName: "obsidian",
		browserVersion: "latest",
		"wdio:obsidianOptions": {
			installerVersion: "latest",
			plugins: ["."], // this repo's main.js/manifest.json/styles.css — build first
			vault: "test/vault",
		},
	}],
	services: ["obsidian"],
	reporters: ["obsidian"],
	cacheDir: path.resolve(".obsidian-cache"),
	mochaOpts: { ui: "bdd", timeout: 60000 },
	logLevel: "warn",
};
