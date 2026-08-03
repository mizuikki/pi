import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (
		reason: "overflow" | "threshold",
		willRetry: boolean,
		retryMessage?: AssistantMessage,
	) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect((result as { summary: string }).summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("manually commits an extension provider checkpoint as a custom entry", async () => {
		const checkpointEvents: unknown[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						providerCheckpoint: {
							token: event.checkpointToken!,
							customType: "fixture.provider-checkpoint",
							checkpointId: "fixture-checkpoint-1",
							data: { kind: "fixture", version: 1 },
						},
					}));
					(pi.on as unknown as (event: "session_provider_checkpoint", handler: (event: unknown) => void) => void)(
						"session_provider_checkpoint",
						(event) => checkpointEvents.push(event),
					);
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const result = await harness.session.compact();

		expect(result).toMatchObject({ kind: "provider_checkpoint", checkpointId: "fixture-checkpoint-1" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		const checkpointEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "fixture.provider-checkpoint");
		expect(checkpointEntry).toMatchObject({
			data: { kind: "fixture", version: 1 },
			navigation: { role: "provider_checkpoint", tokensBefore: expect.any(Number) },
		});
		expect(checkpointEvents).toHaveLength(1);
		expect(checkpointEvents[0]).toMatchObject({
			type: "session_provider_checkpoint",
			checkpointId: "fixture-checkpoint-1",
			trigger: "manual",
			reason: "manual",
			tokensBefore: expect.any(Number),
			willRetry: false,
		});
		expect(checkpointEntry?.type === "custom" ? checkpointEntry.navigation?.tokensBefore : undefined).toBe(
			(checkpointEvents[0] as { tokensBefore: number }).tokensBefore,
		);
	});

	it("blocks manual success when provider checkpoint navigation readback is indeterminate", async () => {
		const indeterminateEvents: unknown[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						providerCheckpoint: {
							token: event.checkpointToken!,
							customType: "fixture.provider-checkpoint",
							checkpointId: "fixture-indeterminate",
							data: { kind: "fixture", version: 1 },
						},
					}));
					pi.on("session_provider_checkpoint_indeterminate", (event) => {
						indeterminateEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const originalGetEntry = harness.sessionManager.getEntry.bind(harness.sessionManager);
		const manager = harness.sessionManager as unknown as { getEntry: (id: string) => unknown };
		manager.getEntry = (id) => {
			const entry = originalGetEntry(id);
			return entry?.type === "custom" ? { ...entry, navigation: undefined } : entry;
		};

		await expect(harness.session.compact()).rejects.toThrow(
			"Provider checkpoint append could not be verified after append",
		);
		expect(indeterminateEvents).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			result: undefined,
			willRetry: false,
		});
	});

	it("settles an overflow provider checkpoint before allowing the one turn retry", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						providerCheckpoint: {
							token: event.checkpointToken!,
							customType: "fixture.provider-checkpoint",
							checkpointId: "fixture-overflow",
							data: { kind: "fixture", version: 1 },
						},
					}));
					pi.on("session_provider_checkpoint", (event) => {
						order.push(`checkpoint:${String(event.willRetry)}`);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const retryMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages.push(retryMessage);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") order.push(`end:${String(event.willRetry)}`);
		});
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(internals._runAutoCompaction("overflow", true, retryMessage)).resolves.toBe(true);

		expect(order).toEqual(["checkpoint:true", "end:true"]);
		expect(harness.sessionManager.getEntries().find((entry) => entry.type === "custom")).toMatchObject({
			navigation: { role: "provider_checkpoint", tokensBefore: expect.any(Number) },
		});
		expect(harness.session.agent.state.messages).not.toContain(retryMessage);
	});

	it("routes an extension compaction failure through one manual error event without fallback", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						errorMessage: "upstream fixture detail",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const fallbackCalls = useSummaryStreamFn(harness, "unexpected fallback summary");

		await expect(harness.session.compact()).rejects.toThrow("upstream fixture detail");

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0]).toMatchObject({
			reason: "manual",
			aborted: false,
			errorMessage: "Compaction failed: upstream fixture detail",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(fallbackCalls()).toBe(0);
	});

	it("routes an extension compaction failure through one automatic error event without fallback", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						errorMessage: "upstream fixture detail",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const fallbackCalls = useSummaryStreamFn(harness, "unexpected fallback summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", false)).resolves.toBe(false);

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0]).toMatchObject({
			reason: "overflow",
			aborted: false,
			errorMessage: "Context overflow recovery failed: upstream fixture detail",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(fallbackCalls()).toBe(0);
	});

	it("routes an extension threshold compaction failure through one automatic error event without fallback", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						errorMessage: "upstream fixture detail",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const fallbackCalls = useSummaryStreamFn(harness, "unexpected fallback summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0]).toMatchObject({
			reason: "threshold",
			aborted: false,
			errorMessage: "Auto-compaction failed: upstream fixture detail",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(fallbackCalls()).toBe(0);
	});

	it("emits the newly appended manual compaction when summaries repeat", async () => {
		const emittedCompactionIds: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "repeated summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async (event) => {
						emittedCompactionIds.push(event.compactionEntry.id);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.compact();
		await harness.session.prompt("three");
		await harness.session.prompt("four");
		await harness.session.compact();

		const compactionIds = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "compaction")
			.map((entry) => entry.id);
		expect(compactionIds).toHaveLength(2);
		expect(emittedCompactionIds).toEqual(compactionIds);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.streamFunction = streamSimple;

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect((result as { summary: string }).summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect((result as { summary: string }).summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("emits the newly appended automatic compaction when summaries repeat", async () => {
		const emittedCompactionIds: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "repeated summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async (event) => {
						emittedCompactionIds.push(event.compactionEntry.id);
					});
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		seedCompactableSession(harness);
		await sessionInternals._runAutoCompaction("threshold", false);
		seedCompactableSession(harness);
		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionIds = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "compaction")
			.map((entry) => entry.id);
		expect(compactionIds).toHaveLength(2);
		expect(emittedCompactionIds).toEqual(compactionIds);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "oversized prompt" }], timestamp: Date.now() - 1000 },
			overflowMessage,
		];
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		expect(harness.session.agent.state.messages).toContain(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("ignores stale assistant overflow and usage before a provider checkpoint boundary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals & {
			setProviderCheckpointUsageBoundary: (entryId?: string) => boolean;
		};
		const staleAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			totalTokens: 610_000,
			timestamp: Date.now() - 10_000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const checkpointEntryId = harness.sessionManager.appendCustomEntry("fixture.provider-checkpoint", {
			kind: "fixture.provider-checkpoint",
			version: 1,
		});
		expect(sessionInternals.setProviderCheckpointUsageBoundary(checkpointEntryId)).toBe(true);
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
