import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { isSdkDefaultStreamFn } from "../src/core/stream-fn-tags.ts";

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

	it("preserves explicit Models carried by a provided model registry", async () => {
		const tempDir = join(tmpdir(), `pi-sdk-explicit-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(tempDir);

		const faux = fauxProvider({
			models: [{ id: "faux-registry", reasoning: false }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("registry models ok")]);
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory(), models);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry,
			model: faux.getModel(),
		});

		try {
			await session.prompt("hello");
			const assistant = [...session.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			expect(
				assistant?.content.some((part) => part.type === "text" && part.text.includes("registry models ok")),
			).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("preserves non-null explicit auth headers when null suppressions are present", async () => {
		const model: Model<"faux"> = {
			id: "header-model",
			name: "Header Model",
			api: "faux",
			provider: "header-provider",
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			headers: { "X-Model": "model" },
		};
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "header-provider",
				name: "Header Provider",
				auth: {
					apiKey: {
						name: "Header Provider",
						resolve: async () => ({
							auth: { headers: { Authorization: "Bearer token", "X-Suppress": null } },
						}),
					},
				},
				models: [model],
				api: {
					stream: () => {
						throw new Error("should not stream while resolving headers");
					},
					streamSimple: () => {
						throw new Error("should not stream while resolving headers");
					},
				},
			}),
		);
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory(), models);

		const auth = await registry.getApiKeyAndHeaders(model);

		expect(auth.ok).toBe(true);
		if (!auth.ok) {
			throw new Error(auth.error);
		}
		expect(auth.apiKey).toBeUndefined();
		expect(auth.headers).toEqual({ "X-Model": "model", Authorization: "Bearer token" });
	});

	it("manually compacts explicit Models sessions without requiring an apiKey", async () => {
		const tempDir = join(tmpdir(), `pi-sdk-explicit-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(tempDir);

		const faux = fauxProvider({
			models: [{ id: "faux-compact", reasoning: false, contextWindow: 128 }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("manual summary"),
			fauxAssistantMessage("manual turn-prefix summary"),
		]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
			}),
			models,
			model: faux.getModel(),
		});

		try {
			expect(isSdkDefaultStreamFn(session.agent.streamFn)).toBe(true);
			const auth = await session.modelRegistry.getApiKeyAndHeaders(faux.getModel());
			expect(auth.ok).toBe(true);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			expect(auth.apiKey).toBeUndefined();

			await session.prompt("hello ".repeat(20));
			await session.prompt("continue ".repeat(20));
			const result = await session.compact();

			expect(result.summary).toContain("manual summary");
			expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("auto-compacts explicit Models sessions without requiring an apiKey", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-sdk-explicit-auto-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(tempDir);

		const faux = fauxProvider({
			models: [{ id: "faux-auto-compact", reasoning: false, contextWindow: 128 }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("first turn"), fauxAssistantMessage("auto summary")]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 1 },
			}),
			models,
			model: faux.getModel(),
		});

		try {
			await session.prompt("hello ".repeat(40));
			const compactionEntry = session.sessionManager.getBranch().find((entry) => entry.type === "compaction");

			expect(compactionEntry).toMatchObject({
				type: "compaction",
				summary: expect.stringContaining("auto summary"),
			});
		} finally {
			session.dispose();
		}
	});
});
