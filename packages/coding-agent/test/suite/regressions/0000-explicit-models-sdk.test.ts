import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mizuikki/pi-ai";
import { createModels, createProvider, fauxAssistantMessage } from "@mizuikki/pi-ai";
import { fauxProvider } from "@mizuikki/pi-ai/providers/faux";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@mizuikki/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

describe("regression: explicit models SDK session flows", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("supports createAgentSessionServices/createAgentSessionRuntime/bindExtensions with explicit models", async () => {
		const tempDir = join(tmpdir(), `pi-explicit-models-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("runtime one"), fauxAssistantMessage("runtime two")]);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				models,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.registerCommand("ping-models", {
								description: "ping",
								handler: async () => {
									pi.sendMessage({
										customType: "test",
										content: "extension ran",
										display: true,
									});
								},
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});

			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					models,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("/ping-models");
		await runtime.session.prompt("follow-up");

		const assistantTexts = runtime.session.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text));

		expect(assistantTexts).toContain("runtime one");
		expect(assistantTexts).toContain("runtime two");
	});

	it("does not restore or expose unauthenticated explicit models as available", async () => {
		const tempDir = join(tmpdir(), `pi-explicit-models-no-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

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

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			models,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		expect(await services.modelRegistry.getAvailable()).toEqual([]);

		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("no-auth", "no-auth-1");
		const { session, modelFallbackMessage } = await createAgentSessionFromServices({
			services,
			sessionManager,
			models,
		});

		cleanups.push(() => {
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(session.model).toMatchObject({ provider: "unknown", id: "unknown", api: "unknown" });
		expect(modelFallbackMessage).toContain("No models available");
		await expect(session.prompt("hello")).rejects.toThrow("No API key found for the selected model");
	});

	it("supports createAgentSessionServices/createAgentSessionFromServices with custom settingsManager", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-explicit-models-services-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });

		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("service settings ok")]);

		const settingsManager = SettingsManager.inMemory({ theme: "light" });
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			models,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			models,
			model: faux.getModel(),
		});

		cleanups.push(() => {
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await session.prompt("hello");
		expect(session.settingsManager).toBe(settingsManager);
		expect(
			session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "service settings ok"),
			),
		).toBe(true);
	});
});
