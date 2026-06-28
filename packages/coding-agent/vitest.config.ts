import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcProvidersDir = fileURLToPath(new URL("../ai/src/providers/", import.meta.url));
const aiSrcApiDir = fileURLToPath(new URL("../ai/src/api/", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@mizuikki\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mizuikki\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@mizuikki\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mizuikki\/pi-ai\/providers\/(.+)$/, replacement: `${aiSrcProvidersDir}$1.ts` },
			{ find: /^@mizuikki\/pi-ai\/api\/(.+)$/, replacement: `${aiSrcApiDir}$1.ts` },
			{ find: /^@mizuikki\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@mizuikki\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mizuikki\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-ai\/providers\/(.+)$/, replacement: `${aiSrcProvidersDir}$1.ts` },
			{ find: /^@mariozechner\/pi-ai\/api\/(.+)$/, replacement: `${aiSrcApiDir}$1.ts` },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
