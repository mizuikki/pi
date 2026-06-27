import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

describe("createAgentSession explicit models", () => {
	const cleanups: string[] = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			const tempDir = cleanups.pop();
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("uses explicit Models without compat registration or deep imports", async () => {
		const tempDir = join(tmpdir(), `pi-sdk-explicit-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(tempDir);

		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("explicit models ok")]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			models,
			model: faux.getModel(),
		});

		try {
			await session.prompt("hello");
			const assistant = [...session.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			expect(assistant?.role).toBe("assistant");
			if (assistant?.role !== "assistant") {
				throw new Error("missing assistant message");
			}
			expect(
				assistant.content.some((part) => part.type === "text" && part.text.includes("explicit models ok")),
			).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("does not treat unauthenticated explicit Models as available or auto-selected", async () => {
		const tempDir = join(tmpdir(), `pi-sdk-explicit-no-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(tempDir);

		const model: Model<"faux"> = {
			id: "no-auth-1",
			name: "No Auth",
			api: "faux",
			provider: "no-auth",
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "no-auth",
				name: "No Auth",
				auth: { apiKey: { name: "No Auth", resolve: async () => undefined } },
				models: [model],
				api: {
					stream: () => {
						throw new Error("should not stream without auth");
					},
					streamSimple: () => {
						throw new Error("should not stream without auth");
					},
				},
			}),
		);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			models,
		});

		try {
			expect(session.model).toMatchObject({ provider: "unknown", id: "unknown", api: "unknown" });
			expect(modelFallbackMessage).toContain("No models available");
			await expect(session.modelRegistry.getAvailable()).resolves.toEqual([]);
			await expect(session.prompt("hello")).rejects.toThrow("No API key found for the selected model");
		} finally {
			session.dispose();
		}
	});

	it("supports custom settingsManager with explicit Models", async () => {
		const tempDir = join(tmpdir(), `pi-sdk-explicit-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(tempDir);

		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("settings manager ok")]);

		const settingsManager = SettingsManager.inMemory({ theme: "light" });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager,
			models,
			model: faux.getModel(),
		});

		try {
			await session.prompt("hello");
			expect(session.settingsManager).toBe(settingsManager);
			const assistant = [...session.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			expect(assistant?.role).toBe("assistant");
		} finally {
			session.dispose();
		}
	});
});
