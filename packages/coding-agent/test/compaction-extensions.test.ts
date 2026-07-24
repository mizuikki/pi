import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * Tests for compaction extension events (before_compact / compact).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	createExtensionRuntime,
	type Extension,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionEvent,
} from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createCodingTools } from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("Compaction extensions", () => {
	let session: AgentSession;
	let tempDir: string;
	let capturedEvents: SessionEvent[];

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-compaction-extensions-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		capturedEvents = [];
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createExtension(
		onBeforeCompact?: (event: SessionBeforeCompactEvent) => { cancel?: boolean; compaction?: any } | undefined,
		onCompact?: (event: SessionCompactEvent) => void,
	): Extension {
		const handlers = new Map<string, ((event: any, ctx: any) => Promise<any>)[]>();

		handlers.set("session_before_compact", [
			async (event: SessionBeforeCompactEvent) => {
				capturedEvents.push(event);
				if (onBeforeCompact) {
					return onBeforeCompact(event);
				}
				return undefined;
			},
		]);

		handlers.set("session_compact", [
			async (event: SessionCompactEvent) => {
				capturedEvents.push(event);
				if (onCompact) {
					onCompact(event);
				}
				return undefined;
			},
		]);

		return {
			path: "test-extension",
			resolvedPath: "/test/test-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:test-extension>", { source: "test" }),
			handlers,
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
	}

	async function createSession(extensions: Extension[]) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => API_KEY,
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(process.cwd()),
			},
		});

		const sessionManager = SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);

		const runtime = createExtensionRuntime();
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => ({ extensions, errors: [], runtime }),
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader,
		});

		return session;
	}

	it("should emit before_compact and compact events", async () => {
		const extension = createExtension();
		await createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const beforeCompactEvents = capturedEvents.filter(
			(e): e is SessionBeforeCompactEvent => e.type === "session_before_compact",
		);
		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");

		expect(beforeCompactEvents.length).toBe(1);
		expect(compactEvents.length).toBe(1);

		const beforeEvent = beforeCompactEvents[0];
		expect(beforeEvent.preparation).toBeDefined();
		expect(beforeEvent.preparation.messagesToSummarize).toBeDefined();
		expect(beforeEvent.preparation.turnPrefixMessages).toBeDefined();
		expect(beforeEvent.preparation.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(typeof beforeEvent.preparation.isSplitTurn).toBe("boolean");
		expect(beforeEvent.branchEntries).toBeDefined();
		// sessionManager, modelRegistry, and model are now on ctx, not event

		const afterEvent = compactEvents[0];
		expect(afterEvent.compactionEntry).toBeDefined();
		expect(afterEvent.compactionEntry.summary.length).toBeGreaterThan(0);
		expect(afterEvent.compactionEntry.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(afterEvent.fromExtension).toBe(false);
	}, 120000);

	it("should allow extensions to cancel compaction", async () => {
		const extension = createExtension(() => ({ cancel: true }));
		await createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await expect(session.compact()).rejects.toThrow("Compaction cancelled");

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(0);
	}, 120000);

	it("should allow extensions to provide custom compaction", async () => {
		const customSummary = "Custom summary from extension";

		const extension = createExtension((event) => {
			if (event.type === "session_before_compact") {
				return {
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return undefined;
		});
		await createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		if (afterEvent.type === "session_compact") {
			expect(afterEvent.compactionEntry.summary).toBe(customSummary);
			expect(afterEvent.fromExtension).toBe(true);
		}
	}, 120000);

	it("should include entries in compact event after compaction is saved", async () => {
		const extension = createExtension();
		await createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		if (afterEvent.type === "session_compact") {
			// sessionManager is now on ctx, use session.sessionManager directly
			const entries = session.sessionManager.getEntries();
			const hasCompactionEntry = entries.some((e: { type: string }) => e.type === "compaction");
			expect(hasCompactionEntry).toBe(true);
		}
	}, 120000);

	it("should continue with default compaction if extension throws error", async () => {
		const throwingExtension: Extension = {
			path: "throwing-extension",
			resolvedPath: "/test/throwing-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:throwing-extension>", { source: "test" }),
			handlers: new Map<string, ((event: any, ctx: any) => Promise<any>)[]>([
				[
					"session_before_compact",
					[
						async (event: SessionBeforeCompactEvent) => {
							capturedEvents.push(event);
							throw new Error("Extension intentionally throws");
						},
					],
				],
				[
					"session_compact",
					[
						async (event: SessionCompactEvent) => {
							capturedEvents.push(event);
							return undefined;
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		await createSession([throwingExtension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);

		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);
		expect(compactEvents[0].fromExtension).toBe(false);
	}, 120000);

	it("should call multiple extensions in order", async () => {
		const callOrder: string[] = [];

		const extension1: Extension = {
			path: "extension1",
			resolvedPath: "/test/extension1.ts",
			sourceInfo: createSyntheticSourceInfo("<test:extension1>", { source: "test" }),
			handlers: new Map<string, ((event: any, ctx: any) => Promise<any>)[]>([
				[
					"session_before_compact",
					[
						async () => {
							callOrder.push("extension1-before");
							return undefined;
						},
					],
				],
				[
					"session_compact",
					[
						async () => {
							callOrder.push("extension1-after");
							return undefined;
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const extension2: Extension = {
			path: "extension2",
			resolvedPath: "/test/extension2.ts",
			sourceInfo: createSyntheticSourceInfo("<test:extension2>", { source: "test" }),
			handlers: new Map<string, ((event: any, ctx: any) => Promise<any>)[]>([
				[
					"session_before_compact",
					[
						async () => {
							callOrder.push("extension2-before");
							return undefined;
						},
					],
				],
				[
					"session_compact",
					[
						async () => {
							callOrder.push("extension2-after");
							return undefined;
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		await createSession([extension1, extension2]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(callOrder).toEqual(["extension1-before", "extension2-before", "extension1-after", "extension2-after"]);
	}, 120000);

	it("should pass correct data in before_compact event", async () => {
		let capturedBeforeEvent: SessionBeforeCompactEvent | null = null;

		const extension = createExtension((event) => {
			capturedBeforeEvent = event;
			return undefined;
		});
		await createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(capturedBeforeEvent).not.toBeNull();
		const event = capturedBeforeEvent!;
		expect(typeof event.preparation.isSplitTurn).toBe("boolean");
		expect(event.preparation.firstKeptEntryId).toBeDefined();

		expect(Array.isArray(event.preparation.messagesToSummarize)).toBe(true);
		expect(Array.isArray(event.preparation.turnPrefixMessages)).toBe(true);

		expect(typeof event.preparation.tokensBefore).toBe("number");

		expect(Array.isArray(event.branchEntries)).toBe(true);

		// sessionManager and model runtime remain available on the session.
		expect(typeof session.sessionManager.getEntries).toBe("function");
		expect(typeof session.modelRuntime.getAuth).toBe("function");

		const entries = session.sessionManager.getEntries();
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);
	}, 120000);

	it("should use extension compaction even with different values", async () => {
		const customSummary = "Custom summary with modified values";

		const extension = createExtension((event) => {
			if (event.type === "session_before_compact") {
				return {
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: 999,
					},
				};
			}
			return undefined;
		});
		await createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);
		expect(result.tokensBefore).toBe(999);
	}, 120000);
});

describe("Provider payload compaction extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("commits provider_inline compaction before dispatch and refreshes the next request snapshot", async () => {
		const sessionCompacts: SessionCompactEvent[] = [];
		const legacyPayloads: unknown[] = [];
		let didCompact = false;
		let harness!: Harness;

		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_payload", async (event) => {
						if (
							event.attribution.origin !== "agent" ||
							event.attribution.compaction === undefined ||
							didCompact
						) {
							return { payload: event.payload };
						}
						didCompact = true;
						return {
							payload: { steps: ["provider", "sealed"] },
							compaction: {
								token: event.attribution.compaction.token,
								summary: "inline summary",
								tokensBefore: 42,
								usage: {
									input: 1,
									output: 2,
									cacheRead: 3,
									cacheWrite: 4,
									totalTokens: 10,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							},
						};
					});
					pi.on("before_provider_request", async (event) => {
						legacyPayloads.push(event.payload);
						return event.payload;
					});
					pi.on("session_compact", async (event) => {
						sessionCompacts.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			async (context, options, _state, model) => {
				expect(context.messages.some((message) => (message as { role: string }).role === "compactionSummary")).toBe(
					false,
				);
				const finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				expect(finalPayload).toEqual({ steps: ["provider", "sealed"] });
				const compactionEntry = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
				expect(compactionEntry?.type).toBe("compaction");
				if (compactionEntry?.type === "compaction") {
					expect(compactionEntry.retainedTail?.length).toBeGreaterThan(0);
					expect(compactionEntry.usage?.totalTokens).toBe(10);
				}
				expect(
					harness.session.messages.some((message) => (message as { role: string }).role === "compactionSummary"),
				).toBe(false);
				return fauxAssistantMessage("second reply");
			},
			async (context) => {
				expect(context.messages.some((message) => (message as { role: string }).role === "compactionSummary")).toBe(
					true,
				);
				return fauxAssistantMessage("third reply");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.prompt("third");

		expect(legacyPayloads).toContainEqual({ steps: ["provider", "sealed"] });
		expect(sessionCompacts).toHaveLength(1);
		expect(sessionCompacts[0]).toMatchObject({
			fromExtension: true,
			reason: "provider_inline",
			trigger: "provider_inline",
			willRetry: false,
		});
	});

	it("rejects payload mutation after an inline compaction proposal", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_payload", async (event) => {
						if (event.attribution.compaction === undefined) {
							return { payload: event.payload };
						}
						return {
							payload: { steps: ["provider", "sealed"] },
							compaction: {
								token: event.attribution.compaction.token,
								summary: "inline summary",
								tokensBefore: 5,
							},
						};
					});
					pi.on("before_provider_request", async () => {
						return { steps: ["provider", "mutated"] };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const runner = (
			harness.session as unknown as {
				_extensionRunner: {
					emitBeforeProviderPayload: (
						model: unknown,
						payload: unknown,
						attribution: { compaction?: unknown },
						signal: AbortSignal,
					) => Promise<unknown>;
				};
			}
		)._extensionRunner;
		const controller = (
			harness.session as unknown as {
				_providerPayloadCompaction: {
					createAttribution: (model: unknown, origin: "agent", signal: AbortSignal) => { compaction?: unknown };
				};
			}
		)._providerPayloadCompaction;
		const signal = new AbortController().signal;
		const attribution = controller.createAttribution(harness.getModel(), "agent", signal);

		expect(attribution.compaction).toBeDefined();
		await expect(
			runner.emitBeforeProviderPayload(harness.getModel(), { steps: ["provider"] }, attribution, signal),
		).rejects.toThrow("Provider payload cannot change after an inline compaction proposal");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("rejects forged, stale, reused, and auxiliary-origin inline compaction tokens", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const controller = (
			harness.session as unknown as {
				_providerPayloadCompaction: {
					createAttribution: (model: unknown, origin: "agent", signal: AbortSignal) => { compaction?: unknown };
					commitPayload: (model: unknown, result: unknown, attribution: unknown) => Promise<unknown>;
				};
			}
		)._providerPayloadCompaction;
		const signal = new AbortController().signal;
		const attribution = controller.createAttribution(harness.getModel(), "agent", signal) as {
			sessionId: string;
			origin: "agent";
			signal: AbortSignal;
			compaction?: { token: unknown };
		};
		expect(attribution.compaction).toBeDefined();

		await expect(
			controller.commitPayload(
				harness.getModel(),
				{
					payload: { steps: ["provider"] },
					compaction: { token: {}, summary: "inline summary", tokensBefore: 1 },
				},
				attribution,
			),
		).rejects.toThrow("stale or forged");

		await expect(
			controller.commitPayload(
				harness.getModel(),
				{
					payload: { steps: ["provider"] },
					compaction: { token: attribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				},
				{ sessionId: attribution.sessionId, origin: "compaction_summary", signal },
			),
		).rejects.toThrow("only allowed for agent-origin");

		const staleAttribution = controller.createAttribution(harness.getModel(), "agent", signal) as {
			compaction?: { token: unknown };
		};
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "stale" }],
			timestamp: Date.now(),
		} as never);
		await expect(
			controller.commitPayload(
				harness.getModel(),
				{
					payload: { steps: ["provider"] },
					compaction: { token: staleAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				},
				staleAttribution,
			),
		).rejects.toThrow("became stale before commit");

		const reusedAttribution = controller.createAttribution(harness.getModel(), "agent", signal) as {
			compaction?: { token: unknown };
		};
		await controller.commitPayload(
			harness.getModel(),
			{
				payload: { steps: ["provider"] },
				compaction: { token: reusedAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
			},
			reusedAttribution,
		);
		await expect(
			controller.commitPayload(
				harness.getModel(),
				{
					payload: { steps: ["provider"] },
					compaction: { token: reusedAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				},
				reusedAttribution,
			),
		).rejects.toThrow("reused");
	});

	it("rejects multiple inline compaction proposals in one reducer pass", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_payload", async (event) => {
						if (event.attribution.compaction === undefined) {
							return { payload: event.payload };
						}
						return {
							payload: { steps: ["provider", "first"] },
							compaction: {
								token: event.attribution.compaction.token,
								summary: "inline summary",
								tokensBefore: 1,
							},
						};
					});
					pi.on("before_provider_payload", async (event) => {
						if (event.attribution.compaction === undefined) {
							return { payload: event.payload };
						}
						return {
							payload: { steps: ["provider", "first"] },
							compaction: {
								token: event.attribution.compaction.token,
								summary: "inline summary",
								tokensBefore: 1,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first");
		const runner = (
			harness.session as unknown as {
				_extensionRunner: {
					emitBeforeProviderPayload: (
						model: unknown,
						payload: unknown,
						attribution: { compaction?: unknown },
						signal: AbortSignal,
					) => Promise<unknown>;
				};
			}
		)._extensionRunner;
		const controller = (
			harness.session as unknown as {
				_providerPayloadCompaction: {
					createAttribution: (model: unknown, origin: "agent", signal: AbortSignal) => { compaction?: unknown };
				};
			}
		)._providerPayloadCompaction;
		const signal = new AbortController().signal;
		const attribution = controller.createAttribution(harness.getModel(), "agent", signal);
		await expect(
			runner.emitBeforeProviderPayload(harness.getModel(), { steps: ["provider"] }, attribution, signal),
		).rejects.toThrow("at most one compaction proposal");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("preserves compatibility-alias ordering across before_provider_request and before_provider_payload", async () => {
		let finalPayload: unknown;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", async () => ({ steps: ["legacy"] }));
				},
				(pi) => {
					pi.on("before_provider_payload", async (event) => ({
						payload: {
							steps: [...((event.payload as { steps: string[] }).steps ?? []), "payload"],
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async (_context, options, _state, model) => {
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("first reply");
			},
		]);

		await harness.session.prompt("first");

		expect(finalPayload).toEqual({ steps: ["legacy", "payload"] });
	});

	it("does not expose compaction tokens to auxiliary compaction-summary requests", async () => {
		const origins: Array<{ origin: string; hasCompaction: boolean }> = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_payload", async (event) => {
						origins.push({
							origin: event.attribution.origin,
							hasCompaction: event.attribution.compaction !== undefined,
						});
						return { payload: event.payload };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			async (_context, options, _state, model) => {
				await options?.onPayload?.({ steps: ["summary", "history"] }, model);
				return fauxAssistantMessage("## Goal\nsummary");
			},
			async (_context, options, _state, model) => {
				await options?.onPayload?.({ steps: ["summary", "turn-prefix"] }, model);
				return fauxAssistantMessage("## Context\nturn summary");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.compact();

		expect(origins.some((entry) => entry.origin === "compaction_summary" && entry.hasCompaction)).toBe(false);
		expect(origins).toContainEqual({ origin: "compaction_summary", hasCompaction: false });
	});

	it("treats missing or mismatched append readback as an indeterminate inline commit", async () => {
		const missingHarness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(missingHarness);
		missingHarness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await missingHarness.session.prompt("first");
		await missingHarness.session.prompt("second");

		const missingController = (
			missingHarness.session as unknown as {
				_providerPayloadCompaction: {
					createAttribution: (
						model: unknown,
						origin: "agent",
						signal: AbortSignal,
					) => {
						compaction?: { token: unknown; candidateLeafId: string };
					};
					commitPayload: (model: unknown, result: unknown, attribution: unknown) => Promise<unknown>;
				};
			}
		)._providerPayloadCompaction;
		const signal = new AbortController().signal;
		let missingIndeterminateEntryId: string | undefined;
		const missingRunner = (
			missingHarness.session as unknown as {
				_extensionRunner: {
					emitCompactionTransactionEvent: (event: { type: string; entryId?: string }) => Promise<void>;
				};
			}
		)._extensionRunner;
		const originalMissingEmit = missingRunner.emitCompactionTransactionEvent.bind(missingRunner);
		missingRunner.emitCompactionTransactionEvent = async (event) => {
			if (event.type === "session_compact_indeterminate") missingIndeterminateEntryId = event.entryId;
			await originalMissingEmit(event as never);
		};
		const missingAttribution = missingController.createAttribution(missingHarness.getModel(), "agent", signal);
		missingHarness.sessionManager.getEntry = (() => undefined) as typeof missingHarness.sessionManager.getEntry;
		await expect(
			missingController.commitPayload(
				missingHarness.getModel(),
				{
					payload: { steps: ["provider"] },
					compaction: {
						token: missingAttribution.compaction!.token,
						summary: "inline summary",
						tokensBefore: 1,
					},
				},
				missingAttribution,
			),
		).rejects.toThrow("could not be verified after append");
		expect(missingIndeterminateEntryId).toBeTruthy();

		const alteredHarness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(alteredHarness);
		alteredHarness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await alteredHarness.session.prompt("first");
		await alteredHarness.session.prompt("second");
		const alteredController = (
			alteredHarness.session as unknown as {
				_providerPayloadCompaction: {
					createAttribution: (
						model: unknown,
						origin: "agent",
						signal: AbortSignal,
					) => {
						compaction?: { token: unknown };
					};
					commitPayload: (model: unknown, result: unknown, attribution: unknown) => Promise<unknown>;
				};
			}
		)._providerPayloadCompaction;
		const originalGetEntry = alteredHarness.sessionManager.getEntry.bind(alteredHarness.sessionManager);
		let alteredIndeterminate = false;
		const alteredRunner = (
			alteredHarness.session as unknown as {
				_extensionRunner: { emitCompactionTransactionEvent: (event: { type: string }) => Promise<void> };
			}
		)._extensionRunner;
		const originalAlteredEmit = alteredRunner.emitCompactionTransactionEvent.bind(alteredRunner);
		alteredRunner.emitCompactionTransactionEvent = async (event) => {
			if (event.type === "session_compact_indeterminate") alteredIndeterminate = true;
			await originalAlteredEmit(event as never);
		};
		const alteredAttribution = alteredController.createAttribution(alteredHarness.getModel(), "agent", signal);
		alteredHarness.sessionManager.getEntry = ((id: string) => {
			const entry = originalGetEntry(id);
			if (entry?.type !== "compaction") return entry;
			return { ...entry, summary: "altered" };
		}) as typeof alteredHarness.sessionManager.getEntry;
		await expect(
			alteredController.commitPayload(
				alteredHarness.getModel(),
				{
					payload: { steps: ["provider"] },
					compaction: {
						token: alteredAttribution.compaction!.token,
						summary: "inline summary",
						tokensBefore: 1,
					},
				},
				alteredAttribution,
			),
		).rejects.toThrow("could not be verified after append");
		expect(alteredIndeterminate).toBe(true);
		alteredHarness.sessionManager.getEntry = originalGetEntry;
	});

	it("binds candidateLeafId as parent while firstKeptEntryId remains the retained-tail cut point", async () => {
		const harness = await createHarness({
			// Keep a multi-message retained tail while still leaving a summarized prefix.
			settings: { compaction: { keepRecentTokens: 8 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("third reply"),
			fauxAssistantMessage("fourth reply"),
			fauxAssistantMessage("fifth reply"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.prompt("third");
		await harness.session.prompt("fourth");
		await harness.session.prompt("fifth");

		const controller = (
			harness.session as unknown as {
				_providerPayloadCompaction: {
					createAttribution: (
						model: unknown,
						origin: "agent",
						signal: AbortSignal,
					) => {
						compaction?: { token: unknown; candidateLeafId: string; candidateRetainedTail: unknown[] };
					};
					commitPayload: (model: unknown, result: unknown, attribution: unknown) => Promise<unknown>;
				};
			}
		)._providerPayloadCompaction;
		const signal = new AbortController().signal;
		const attribution = controller.createAttribution(harness.getModel(), "agent", signal);
		expect(attribution.compaction).toBeDefined();
		const leafId = harness.sessionManager.getLeafId();
		expect(attribution.compaction!.candidateLeafId).toBe(leafId);
		expect(attribution.compaction!.candidateRetainedTail.length).toBeGreaterThan(1);

		await controller.commitPayload(
			harness.getModel(),
			{
				payload: { steps: ["provider"] },
				compaction: {
					token: attribution.compaction!.token,
					summary: "inline summary",
					tokensBefore: 9,
				},
			},
			attribution,
		);
		const compactionEntry = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(compactionEntry?.type).toBe("compaction");
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.parentId).toBe(leafId);
			expect(compactionEntry.firstKeptEntryId).not.toBe(leafId);
			expect(compactionEntry.retainedTail?.length).toBeGreaterThan(1);
			expect(harness.sessionManager.getFullActivePathSnapshot().map((entry) => entry.id)).toContain(
				compactionEntry.firstKeptEntryId,
			);
		}
	});
});
