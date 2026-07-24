import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { calculateTool } from "../utils/calculate.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

/** Shared collection; each faux provider gets a unique id so coexisting fakes route correctly. */
const models = createModels();
let fauxCount = 0;

function newFaux(): FauxProviderHandle {
	const faux = fauxProvider({ provider: `faux-${++fauxCount}` });
	models.setProvider(faux.provider);
	return faux;
}

function createHarness(options: ConstructorParameters<typeof AgentHarness>[0]): AgentHarness {
	return new AgentHarness(options);
}

function captureOptions(options: StreamOptions | undefined): StreamOptions {
	return {
		...options,
		headers: options?.headers ? { ...options.headers } : undefined,
		metadata: options?.metadata ? { ...options.metadata } : undefined,
	};
}

describe("AgentHarness stream configuration", () => {
	it("snapshots stream options before provider request hooks", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = newFaux();
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const session = new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				maxRetries: 2,
				maxRetryDelayMs: 3000,
				headers: { "x-base": "base" },
				metadata: { base: true },
				cacheRetention: "none",
			},
		});

		harness.on("before_provider_request", (event) => {
			expect(event.sessionId).toBe("session-1");
			expect(event.streamOptions.headers).toEqual({ "x-base": "base" });
			return {
				streamOptions: {
					headers: { "x-hook": "hook" },
					metadata: { hook: true },
				},
			};
		});

		await harness.prompt("hello");

		expect(capturedOptions).toMatchObject({
			timeoutMs: 1000,
			maxRetries: 2,
			maxRetryDelayMs: 3000,
			sessionId: "session-1",
			cacheRetention: "none",
		});
		expect(capturedOptions?.headers).toEqual({ "x-base": "base", "x-hook": "hook" });
		expect(capturedOptions?.metadata).toEqual({ base: true, hook: true });
	});

	it("chains provider request patches and supports deletion semantics", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = newFaux();
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				maxRetries: 2,
				headers: { keep: "base", remove: "base" },
				metadata: { keep: "base", remove: "base" },
			},
		});

		harness.on("before_provider_request", (event) => {
			expect(event.streamOptions.headers).toEqual({ keep: "base", remove: "base" });
			return {
				streamOptions: {
					headers: { first: "1", remove: undefined },
					metadata: { first: 1, remove: undefined },
				},
			};
		});
		harness.on("before_provider_request", (event) => {
			expect(event.streamOptions.headers).toEqual({ keep: "base", first: "1" });
			expect(event.streamOptions.metadata).toEqual({ keep: "base", first: 1 });
			return {
				streamOptions: {
					timeoutMs: undefined,
					headers: { second: "2" },
					metadata: undefined,
				},
			};
		});

		await harness.prompt("hello");

		expect(capturedOptions?.timeoutMs).toBeUndefined();
		expect(capturedOptions?.maxRetries).toBe(2);
		expect(capturedOptions?.headers).toEqual({ keep: "base", first: "1", second: "2" });
		expect(capturedOptions?.metadata).toBeUndefined();
	});

	it("uses updated stream options for save-point snapshots without mutating the active request", async () => {
		const capturedOptions: StreamOptions[] = [];
		const registration = newFaux();
		registration.setResponses([
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage("done");
			},
		]);

		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
			streamOptions: { timeoutMs: 1000, headers: { turn: "first" } },
		});

		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				harness.setStreamOptions({ timeoutMs: 2000, headers: { turn: "second" } });
			}
		});

		await harness.prompt("hello");

		expect(capturedOptions).toHaveLength(2);
		expect(capturedOptions[0].timeoutMs).toBe(1000);
		expect(capturedOptions[0].headers).toEqual({ turn: "first" });
		expect(capturedOptions[1].timeoutMs).toBe(2000);
		expect(capturedOptions[1].headers).toEqual({ turn: "second" });
	});

	it("chains provider payload hooks", async () => {
		const seenPayloads: unknown[] = [];
		let finalPayload: unknown;
		const registration = newFaux();
		registration.setResponses([
			async (_context, options, _state, model) => {
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});

		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first"] } };
		});
		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first", "second"] } };
		});

		await harness.prompt("hello");

		expect(seenPayloads).toEqual([{ steps: ["provider"] }, { steps: ["provider", "first"] }]);
		expect(finalPayload).toEqual({ steps: ["provider", "first", "second"] });
	});

	it("commits provider-inline compaction before dispatch and preserves the in-flight snapshot", async () => {
		let finalPayload: unknown;
		const compactEvents: Array<{ trigger: string; fromHook: boolean }> = [];
		const registration = newFaux();
		registration.setResponses([
			async (context, options, _state, model) => {
				expect(context.messages.some((message) => (message as { role: string }).role === "compactionSummary")).toBe(
					false,
				);
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
			async (context) => {
				expect(context.messages.some((message) => (message as { role: string }).role === "compactionSummary")).toBe(
					true,
				);
				return fauxAssistantMessage("follow-up");
			},
		]);

		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		harness.on("before_provider_payload", (event) => {
			if (event.attribution.compaction === undefined) {
				return { payload: event.payload };
			}
			return {
				payload: { steps: ["provider", "sealed"] },
				compaction: {
					token: event.attribution.compaction.token,
					summary: "inline summary",
					tokensBefore: 42,
				},
			};
		});
		harness.subscribe((event) => {
			if (event.type === "session_compact") {
				compactEvents.push({ trigger: event.trigger, fromHook: event.fromHook });
			}
		});

		await harness.prompt("hello");
		expect(finalPayload).toEqual({ steps: ["provider", "sealed"] });
		const compactionEntry = (await session.getEntries()).find((entry) => entry.type === "compaction");
		expect(compactionEntry?.type).toBe("compaction");
		expect(compactEvents).toEqual([{ trigger: "provider_inline", fromHook: true }]);

		await harness.prompt("again");
	});

	it("rejects payload mutation after a provider-inline compaction proposal", async () => {
		const registration = newFaux();
		registration.setResponses([
			async (_context, options, _state, model) => {
				await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);

		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		harness.on("before_provider_payload", (event) => {
			if (event.attribution.compaction === undefined) {
				return { payload: event.payload };
			}
			return {
				payload: { steps: ["provider", "sealed"] },
				compaction: {
					token: event.attribution.compaction.token,
					summary: "inline summary",
					tokensBefore: 1,
				},
			};
		});
		harness.on("before_provider_payload", () => ({ payload: { steps: ["provider", "mutated"] } }));

		const assistant = await harness.prompt("hello");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toContain("Provider payload cannot change after an inline compaction proposal");
		expect((await session.getEntries()).filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("rejects forged, stale, reused, auxiliary-origin, and duplicate inline compaction proposals", async () => {
		const registration = newFaux();
		registration.setResponses([fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const internal = harness as unknown as {
			createProviderPayloadAttribution: (
				model: unknown,
				signal: AbortSignal,
			) => Promise<{
				origin: "agent";
				sessionId: string;
				signal: AbortSignal;
				compaction?: { token: object };
			}>;
			commitProviderPayloadCompaction: (
				model: unknown,
				payload: unknown,
				proposal: { token: object; summary: string; tokensBefore: number },
				attribution: { origin: string; sessionId: string; signal: AbortSignal; compaction?: { token: object } },
			) => Promise<unknown>;
		};
		const signal = new AbortController().signal;
		const attribution = await internal.createProviderPayloadAttribution(registration.getModel(), signal);
		expect(attribution.compaction).toBeDefined();

		await expect(
			internal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: {}, summary: "inline summary", tokensBefore: 1 },
				attribution,
			),
		).rejects.toThrow("stale or forged");

		await expect(
			internal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: attribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				{ ...attribution, origin: "compaction_summary", compaction: undefined },
			),
		).rejects.toThrow("only allowed for agent-origin");

		const staleAttribution = await internal.createProviderPayloadAttribution(registration.getModel(), signal);
		await session.appendMessage(createUserMessage("stale"));
		await expect(
			internal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: staleAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				staleAttribution,
			),
		).rejects.toThrow("became stale before commit");

		const compactEvents: Array<{ trigger: string; fromHook: boolean }> = [];
		harness.subscribe((event) => {
			if (event.type === "session_compact") {
				compactEvents.push({ trigger: event.trigger, fromHook: event.fromHook });
			}
		});
		const reusedAttribution = await internal.createProviderPayloadAttribution(registration.getModel(), signal);
		await internal.commitProviderPayloadCompaction(
			registration.getModel(),
			{ steps: ["provider"] },
			{ token: reusedAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
			reusedAttribution,
		);
		await expect(
			internal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: reusedAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				reusedAttribution,
			),
		).rejects.toThrow("reused");
		expect(compactEvents).toHaveLength(1);
		expect((await session.getEntries()).filter((entry) => entry.type === "compaction")).toHaveLength(1);

		const duplicateHarness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		duplicateHarness.on("before_provider_payload", (event) => {
			if (event.attribution.compaction === undefined) return { payload: event.payload };
			return {
				payload: { steps: ["provider", "first"] },
				compaction: {
					token: event.attribution.compaction.token,
					summary: "inline summary",
					tokensBefore: 1,
				},
			};
		});
		duplicateHarness.on("before_provider_payload", (event) => {
			if (event.attribution.compaction === undefined) return { payload: event.payload };
			return {
				payload: { steps: ["provider", "first"] },
				compaction: {
					token: event.attribution.compaction.token,
					summary: "inline summary",
					tokensBefore: 1,
				},
			};
		});
		const duplicateRegistration = newFaux();
		duplicateRegistration.setResponses([
			async (_context, options, _state, model) => {
				await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);
		duplicateHarness.setModel(duplicateRegistration.getModel());
		const duplicateAssistant = await duplicateHarness.prompt("hello");
		expect(duplicateAssistant.stopReason).toBe("error");
		expect(duplicateAssistant.errorMessage).toContain("at most one compaction proposal");
	});

	it("treats missing or mismatched append readback as an indeterminate inline commit", async () => {
		const registration = newFaux();
		registration.setResponses([fauxAssistantMessage("ok")]);
		const missingSession = new Session(new InMemorySessionStorage());
		await missingSession.appendMessage(createUserMessage("one"));
		await missingSession.appendMessage(createAssistantMessage("two"));
		const missingHarness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: missingSession,
			model: registration.getModel(),
		});
		const missingIndeterminate: Array<string | undefined> = [];
		missingHarness.on("session_compact_indeterminate", (event) => {
			missingIndeterminate.push(event.entryId);
			return undefined;
		});
		const missingInternal = missingHarness as unknown as {
			createProviderPayloadAttribution: (
				model: unknown,
				signal: AbortSignal,
			) => Promise<{ origin: "agent"; sessionId: string; signal: AbortSignal; compaction?: { token: object } }>;
			commitProviderPayloadCompaction: (
				model: unknown,
				payload: unknown,
				proposal: { token: object; summary: string; tokensBefore: number },
				attribution: { origin: string; sessionId: string; signal: AbortSignal; compaction?: { token: object } },
			) => Promise<unknown>;
		};
		const signal = new AbortController().signal;
		const missingAttribution = await missingInternal.createProviderPayloadAttribution(
			registration.getModel(),
			signal,
		);
		missingSession.getEntry = (async () => undefined) as typeof missingSession.getEntry;
		await expect(
			missingInternal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: missingAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				missingAttribution,
			),
		).rejects.toThrow("could not be verified after append");
		expect(missingIndeterminate).toHaveLength(1);
		expect(missingIndeterminate[0]).toBeTruthy();

		const alteredSession = new Session(new InMemorySessionStorage());
		await alteredSession.appendMessage(createUserMessage("one"));
		await alteredSession.appendMessage(createAssistantMessage("two"));
		const alteredHarness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: alteredSession,
			model: registration.getModel(),
		});
		let alteredIndeterminate = 0;
		alteredHarness.on("session_compact_indeterminate", () => {
			alteredIndeterminate += 1;
			return undefined;
		});
		const alteredInternal = alteredHarness as unknown as {
			createProviderPayloadAttribution: (
				model: unknown,
				signal: AbortSignal,
			) => Promise<{ origin: "agent"; sessionId: string; signal: AbortSignal; compaction?: { token: object } }>;
			commitProviderPayloadCompaction: (
				model: unknown,
				payload: unknown,
				proposal: { token: object; summary: string; tokensBefore: number },
				attribution: { origin: string; sessionId: string; signal: AbortSignal; compaction?: { token: object } },
			) => Promise<unknown>;
		};
		const originalGetEntry = alteredSession.getEntry.bind(alteredSession);
		const alteredAttribution = await alteredInternal.createProviderPayloadAttribution(
			registration.getModel(),
			signal,
		);
		alteredSession.getEntry = (async (id: string) => {
			const entry = await originalGetEntry(id);
			if (entry?.type !== "compaction") return entry;
			return { ...entry, summary: "altered" };
		}) as typeof alteredSession.getEntry;
		await expect(
			alteredInternal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: alteredAttribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				alteredAttribution,
			),
		).rejects.toThrow("could not be verified after append");
		expect(alteredIndeterminate).toBe(1);
		alteredSession.getEntry = originalGetEntry;
	});

	it("does not report a verified inline commit as indeterminate when success dispatch fails", async () => {
		const registration = newFaux();
		registration.setResponses([fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const emitted: string[] = [];
		harness.on("session_compact", () => {
			emitted.push("session_compact");
			throw new Error("success handler failed");
		});
		harness.on("session_compact_indeterminate", () => {
			emitted.push("session_compact_indeterminate");
			return undefined;
		});
		const internal = harness as unknown as {
			createProviderPayloadAttribution: (
				model: unknown,
				signal: AbortSignal,
			) => Promise<{ origin: "agent"; sessionId: string; signal: AbortSignal; compaction?: { token: object } }>;
			commitProviderPayloadCompaction: (
				model: unknown,
				payload: unknown,
				proposal: { token: object; summary: string; tokensBefore: number },
				attribution: { origin: string; sessionId: string; signal: AbortSignal; compaction?: { token: object } },
			) => Promise<unknown>;
		};
		const attribution = await internal.createProviderPayloadAttribution(
			registration.getModel(),
			new AbortController().signal,
		);

		await expect(
			internal.commitProviderPayloadCompaction(
				registration.getModel(),
				{ steps: ["provider"] },
				{ token: attribution.compaction!.token, summary: "inline summary", tokensBefore: 1 },
				attribution,
			),
		).rejects.toThrow("success handler failed");
		expect(emitted).toEqual(["session_compact"]);
		expect((await session.getEntries()).filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("binds candidateLeafId as parent while firstKeptEntryId remains the retained-tail cut point", async () => {
		const registration = newFaux();
		registration.setResponses([fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		await session.appendMessage(createUserMessage("three"));
		await session.appendMessage(createAssistantMessage("four"));
		await session.appendMessage(createUserMessage("five"));
		const harness = createHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const internal = harness as unknown as {
			createProviderPayloadAttribution: (
				model: unknown,
				signal: AbortSignal,
			) => Promise<{
				origin: "agent";
				sessionId: string;
				signal: AbortSignal;
				compaction?: { token: object; candidateLeafId: string; candidateRetainedTail: unknown[] };
			}>;
			commitProviderPayloadCompaction: (
				model: unknown,
				payload: unknown,
				proposal: { token: object; summary: string; tokensBefore: number },
				attribution: {
					origin: string;
					sessionId: string;
					signal: AbortSignal;
					compaction?: { token: object; candidateLeafId: string };
				},
			) => Promise<unknown>;
		};
		const signal = new AbortController().signal;
		const attribution = await internal.createProviderPayloadAttribution(registration.getModel(), signal);
		expect(attribution.compaction).toBeDefined();
		const leafId = await session.getLeafId();
		expect(attribution.compaction!.candidateLeafId).toBe(leafId);
		expect(attribution.compaction!.candidateRetainedTail.length).toBeGreaterThan(0);

		await internal.commitProviderPayloadCompaction(
			registration.getModel(),
			{ steps: ["provider"] },
			{ token: attribution.compaction!.token, summary: "inline summary", tokensBefore: 9 },
			attribution,
		);
		const compactionEntry = (await session.getEntries()).find((entry) => entry.type === "compaction");
		expect(compactionEntry?.type).toBe("compaction");
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.parentId).toBe(leafId);
			expect(compactionEntry.firstKeptEntryId).not.toBe(leafId);
			expect(compactionEntry.retainedTail?.length).toBeGreaterThan(0);
			expect((await session.getFullActivePathSnapshot()).map((entry) => entry.id)).toContain(
				compactionEntry.firstKeptEntryId,
			);
		}
	});
});
