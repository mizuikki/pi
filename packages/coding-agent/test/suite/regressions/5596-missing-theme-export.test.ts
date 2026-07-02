import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createTestResourceLoader } from "../../utilities.ts";

describe("regression #5596: missing configured theme export", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		initTheme("dark");
	});

	it("exports with the active fallback theme when the configured theme is missing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-5596-"));
		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hello")]);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage, models);

		const settingsManager = SettingsManager.inMemory({ theme: "missing-theme" });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			streamFn: (requestModel, context, options) => models.streamSimple(requestModel, context, options),
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			models,
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(() => {
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await session.prompt("hi");
		initTheme(settingsManager.getTheme());

		const outputPath = join(tempDir, "export.html");
		await expect(session.exportToHtml(outputPath)).resolves.toBe(outputPath);
		expect(existsSync(outputPath)).toBe(true);
		expect(settingsManager.getTheme()).toBe("missing-theme");
	});
});
