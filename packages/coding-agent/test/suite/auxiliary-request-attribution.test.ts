import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionPreparation, compact } from "../../src/core/compaction/index.ts";
import type { ProviderRequestOrigin } from "../../src/core/extensions/index.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_compactionAbortController: AbortController | undefined;
	_getAuxiliaryStreamFn: (origin: "compaction_summary" | "branch_summary") => StreamFn;
};

interface RecordedRequest {
	origin: ProviderRequestOrigin;
	sessionId: string;
}

function recordingExtension(requests: RecordedRequest[], signals?: Array<AbortSignal | undefined>): ExtensionFactory {
	return (pi) => {
		pi.on("before_provider_request", (event, ctx) => {
			requests.push({ origin: event.origin, sessionId: event.sessionId });
			signals?.push(ctx.signal);
			return event.payload;
		});
	};
}

function responseWithPayload(text: string, expectedSessionId: string): FauxResponseStep {
	return async (_context, options, _state, model) => {
		expect(options?.sessionId).toBe(expectedSessionId);
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		const payload = { kind: "synthetic" };
		expect(await options?.onPayload?.(payload, model)).toEqual(payload);
		return fauxAssistantMessage(text);
	};
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({ role: "user", content: "message to compact", timestamp: now - 2 });
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("answer to compact", { timestamp: now - 1 }),
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("provider request attribution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("attributes normal agent requests to the SessionManager session", async () => {
		const requests: RecordedRequest[] = [];
		const harness = await createHarness({ extensionFactories: [recordingExtension(requests)] });
		harnesses.push(harness);
		harness.setResponses([responseWithPayload("answer", harness.sessionManager.getSessionId())]);

		await harness.session.prompt("question");

		expect(requests).toEqual([{ origin: "agent", sessionId: harness.sessionManager.getSessionId() }]);
	});

	it("attributes manual compaction summaries without changing their payload", async () => {
		const requests: RecordedRequest[] = [];
		const harness = await createHarness({ extensionFactories: [recordingExtension(requests)] });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([responseWithPayload("manual summary", harness.sessionManager.getSessionId())]);

		await harness.session.compact();

		expect(requests).toEqual([{ origin: "compaction_summary", sessionId: harness.sessionManager.getSessionId() }]);
	});

	it("attributes overflow compaction summaries to the same session", async () => {
		const requests: RecordedRequest[] = [];
		const harness = await createHarness({ extensionFactories: [recordingExtension(requests)] });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([responseWithPayload("overflow summary", harness.sessionManager.getSessionId())]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("overflow", false);

		expect(requests).toEqual([{ origin: "compaction_summary", sessionId: harness.sessionManager.getSessionId() }]);
	});

	it("attributes both history and turn-prefix requests during split compaction", async () => {
		const requests: RecordedRequest[] = [];
		const harness = await createHarness({ extensionFactories: [recordingExtension(requests)] });
		harnesses.push(harness);
		harness.setResponses([
			responseWithPayload("history summary", harness.sessionManager.getSessionId()),
			responseWithPayload("turn-prefix summary", harness.sessionManager.getSessionId()),
		]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const message = { role: "user" as const, content: "summarize", timestamp: Date.now() };
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [message],
			turnPrefixMessages: [message],
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
		};

		await compact(
			preparation,
			harness.getModel(),
			"faux-key",
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			sessionInternals._getAuxiliaryStreamFn("compaction_summary"),
		);

		expect(requests).toEqual([
			{ origin: "compaction_summary", sessionId: harness.sessionManager.getSessionId() },
			{ origin: "compaction_summary", sessionId: harness.sessionManager.getSessionId() },
		]);
	});

	it("preserves caller payload transforms for auxiliary requests", async () => {
		const requests: RecordedRequest[] = [];
		const harness = await createHarness({ extensionFactories: [recordingExtension(requests)] });
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const streamFn = sessionInternals._getAuxiliaryStreamFn("compaction_summary");
		const controller = new AbortController();
		harness.setResponses([
			async (_context, options, _state, model) => {
				const payload = { stage: "initial" };
				expect(await options?.onPayload?.(payload, model)).toEqual({ stage: "caller" });
				return fauxAssistantMessage("summary");
			},
		]);

		await (
			await streamFn(
				harness.getModel(),
				{ systemPrompt: "", messages: [] },
				{
					signal: controller.signal,
					onPayload: () => ({ stage: "caller" }),
				},
			)
		).result();

		expect(requests).toEqual([{ origin: "compaction_summary", sessionId: harness.sessionManager.getSessionId() }]);
	});

	it("attributes branch summaries to the SessionManager session", async () => {
		const requests: RecordedRequest[] = [];
		const harness = await createHarness({ extensionFactories: [recordingExtension(requests)] });
		harnesses.push(harness);
		const now = Date.now();
		const rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: now - 4 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("first answer", { timestamp: now - 3 }),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
		});
		harness.sessionManager.appendMessage({ role: "user", content: "branch", timestamp: now - 2 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("branch answer", { timestamp: now - 1 }),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([responseWithPayload("branch summary", harness.sessionManager.getSessionId())]);

		await harness.session.navigateTree(rootId, { summarize: true });

		expect(requests).toEqual([{ origin: "branch_summary", sessionId: harness.sessionManager.getSessionId() }]);
	});

	it("uses the compaction lifecycle signal and clears it after abort", async () => {
		const requests: RecordedRequest[] = [];
		const extensionSignals: Array<AbortSignal | undefined> = [];
		const harness = await createHarness({
			extensionFactories: [recordingExtension(requests, extensionSignals)],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		let markStarted: (() => void) | undefined;
		let providerSignal: AbortSignal | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		harness.setResponses([
			async (_context, options, _state, model) => {
				expect(options?.sessionId).toBe(harness.sessionManager.getSessionId());
				providerSignal = options?.signal;
				const payload = { kind: "synthetic" };
				expect(await options?.onPayload?.(payload, model)).toEqual(payload);
				markStarted?.();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compactPromise = harness.session.compact();
		await started;
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
		expect(requests).toEqual([{ origin: "compaction_summary", sessionId: harness.sessionManager.getSessionId() }]);
		expect(extensionSignals).toHaveLength(1);
		expect(extensionSignals[0]).toBe(providerSignal);
		expect(sessionInternals._compactionAbortController).toBeUndefined();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});
});
