import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});

		return session;
	}

	async function createSessionFromServices(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!,
		});
		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFn = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("reclamps thinking level when provider refresh swaps the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("thinking-provider", {
					api: "anthropic-messages",
					baseUrl: "http://localhost:8080/thinking-provider",
					apiKey: "thinking-key",
					models: [
						{
							id: "thinking-model",
							name: "Thinking Model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8192,
						},
					],
				});
				pi.registerCommand("downgrade-thinking", {
					description: "Downgrade active model thinking support",
					handler: async () => {
						pi.registerProvider("thinking-provider", {
							api: "anthropic-messages",
							baseUrl: "http://localhost:8080/thinking-provider",
							apiKey: "thinking-key",
							models: [
								{
									id: "thinking-model",
									name: "Thinking Model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 200000,
									maxTokens: 8192,
								},
							],
						});
					},
				});
			},
		]);

		await session.bindExtensions({});
		const thinkingModel = session.modelRuntime.getModel("thinking-provider", "thinking-model");
		expect(thinkingModel).toBeDefined();
		await session.setModel(thinkingModel!);
		session.setThinkingLevel("high");

		expect(session.thinkingLevel).toBe("high");

		await session.prompt("/downgrade-thinking");

		expect(session.model?.provider).toBe("thinking-provider");
		expect(session.model?.id).toBe("thinking-model");
		expect(session.thinkingLevel).toBe("off");

		session.dispose();
	});

	it("reload clears removed extension provider overrides", async () => {
		const defaultBaseUrl = getModel("anthropic", "claude-sonnet-4-5")!.baseUrl;
		let overrideEnabled = true;
		const session = await createSession([
			(pi) => {
				if (overrideEnabled) {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/reload" });
				}
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/reload");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/reload");

		overrideEnabled = false;
		await session.reload();

		expect(session.model?.baseUrl).toBe(defaultBaseUrl);
		expect(await capturePromptBaseUrl(session)).toBe(defaultBaseUrl);

		session.dispose();
	});

	it("reload clears removed extension provider overrides through createAgentSessionServices", async () => {
		const defaultBaseUrl = getModel("anthropic", "claude-sonnet-4-5")!.baseUrl;
		let overrideEnabled = true;
		const session = await createSessionFromServices([
			(pi) => {
				if (overrideEnabled) {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/services-reload" });
				}
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/services-reload");

		overrideEnabled = false;
		await session.reload();

		expect(session.model?.baseUrl).toBe(defaultBaseUrl);
		expect(await capturePromptBaseUrl(session)).toBe(defaultBaseUrl);

		session.dispose();
	});

	it("reload preserves the selected session_start provider model when it is re-registered", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("reload-provider", {
						api: "anthropic-messages",
						baseUrl: "http://localhost:8080/reload-provider",
						apiKey: "reload-key",
						models: [
							{
								id: "reload-model",
								name: "Reload Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					});
				});
			},
		]);

		await session.bindExtensions({ onError: () => {} });
		const reloadModel = session.modelRuntime.getModel("reload-provider", "reload-model");
		expect(reloadModel).toBeDefined();
		await session.setModel(reloadModel!);

		await session.reload();

		expect(session.model?.provider).toBe("reload-provider");
		expect(session.model?.id).toBe("reload-model");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/reload-provider");

		session.dispose();
	});
});
