import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession reload stale extension contexts", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-reload-stale-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
			allowModelNetwork: false,
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

	it("invalidates captured pi and ctx after ctx.reload()", async () => {
		let staleCtxThrows = false;
		let stalePiThrows = false;
		const session = await createSession([
			(pi) => {
				pi.registerCommand("reload-check", {
					description: "Reload and probe stale context",
					handler: async (_args, ctx) => {
						const oldCtx = ctx;
						const oldPi = pi;
						await ctx.reload();

						try {
							oldCtx.sessionManager.getSessionFile();
						} catch {
							staleCtxThrows = true;
						}

						try {
							oldPi.getActiveTools();
						} catch {
							stalePiThrows = true;
						}
					},
				});
			},
		]);

		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {
					await session.reload();
				},
			},
			onError: () => {},
		});

		await session.prompt("/reload-check");

		expect(staleCtxThrows).toBe(true);
		expect(stalePiThrows).toBe(true);

		session.dispose();
	});

	it("keeps the previous pi and ctx usable when reload fails", async () => {
		let reloadFailed = false;
		let previousCtxStillUsable = false;
		let previousPiStillUsable = false;
		const session = await createSession([
			(pi) => {
				pi.registerCommand("reload-fail-check", {
					description: "Reload and verify failure-path context validity",
					handler: async (_args, ctx) => {
						const oldCtx = ctx;
						const oldPi = pi;
						try {
							await ctx.reload();
						} catch {
							reloadFailed = true;
						}

						try {
							oldCtx.sessionManager.getSessionFile();
							previousCtxStillUsable = true;
						} catch {
							previousCtxStillUsable = false;
						}

						try {
							oldPi.getActiveTools();
							previousPiStillUsable = true;
						} catch {
							previousPiStillUsable = false;
						}
					},
				});
			},
		]);

		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {
					await session.reload({
						beforeSessionStart: async () => {
							throw new Error("reload failed on purpose");
						},
					});
				},
			},
			onError: () => {},
		});

		await session.prompt("/reload-fail-check");

		expect(reloadFailed).toBe(true);
		expect(previousCtxStillUsable).toBe(true);
		expect(previousPiStillUsable).toBe(true);

		session.dispose();
	});
});
