import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { prepareCompaction } from "./compaction/index.ts";
import type {
	BeforeProviderPayloadEventResult,
	ExtensionRunner,
	ProviderCompactionCommitToken,
	ProviderPayloadAttribution,
	ProviderRequestOrigin,
} from "./extensions/index.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

const providerCompactionTokenRuntimeBrand = Symbol("providerCompactionCommitToken");

interface ProviderInlineCompactionSnapshot {
	sessionId: string;
	providerId: string;
	modelId: string;
	leafId: string;
	firstKeptEntryId: string;
	retainedTail: readonly AgentMessage[];
	consumed: boolean;
}

function freezeStructuredValue<T>(value: T): T {
	const stack: unknown[] = [value];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (typeof current !== "object" || current === null || seen.has(current)) continue;
		seen.add(current);
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
		} else {
			for (const item of Object.values(current as Record<string, unknown>)) {
				stack.push(item);
			}
		}
		Object.freeze(current);
	}
	return value;
}

function cloneAndFreezeMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	return freezeStructuredValue(structuredClone(messages));
}

function normalizeSummary(summary: unknown): string {
	if (typeof summary !== "string" || summary.trim().length === 0) {
		throw new Error("Inline compaction proposals must include a non-empty summary");
	}
	return summary;
}

function normalizeTokensBefore(tokensBefore: unknown): number {
	if (!Number.isFinite(tokensBefore) || typeof tokensBefore !== "number" || tokensBefore < 0) {
		throw new Error("Inline compaction proposals must include a finite non-negative token count");
	}
	return Math.trunc(tokensBefore);
}

export class ProviderPayloadCompactionController {
	readonly #sessionManager: SessionManager;
	readonly #settingsManager: SettingsManager;
	readonly #extensionRunnerRef: { current?: ExtensionRunner };
	readonly #snapshots = new WeakMap<object, ProviderInlineCompactionSnapshot>();

	constructor(
		sessionManager: SessionManager,
		settingsManager: SettingsManager,
		extensionRunnerRef: { current?: ExtensionRunner },
	) {
		this.#sessionManager = sessionManager;
		this.#settingsManager = settingsManager;
		this.#extensionRunnerRef = extensionRunnerRef;
	}

	createAttribution(
		model: Model<any>,
		origin: ProviderRequestOrigin,
		signal: AbortSignal,
	): ProviderPayloadAttribution {
		const sessionId = this.#sessionManager.getSessionId();
		if (origin !== "agent") {
			return { sessionId, origin, signal };
		}
		const leafId = this.#sessionManager.getLeafId();
		if (leafId === null) {
			return { sessionId, origin, signal };
		}
		const preparation = prepareCompaction(
			this.#sessionManager.getBranch(),
			this.#settingsManager.getCompactionSettings(),
		);
		if (!preparation) {
			return { sessionId, origin, signal };
		}

		const token = Object.freeze({
			[providerCompactionTokenRuntimeBrand]: true,
		}) as unknown as ProviderCompactionCommitToken;
		const candidateRetainedTail = cloneAndFreezeMessages(preparation.retainedTail);
		this.#snapshots.set(token as object, {
			sessionId,
			providerId: model.provider,
			modelId: model.id,
			leafId,
			firstKeptEntryId: preparation.firstKeptEntryId,
			retainedTail: candidateRetainedTail,
			consumed: false,
		});

		return {
			sessionId,
			origin,
			signal,
			compaction: Object.freeze({
				token,
				candidateLeafId: leafId,
				candidateRetainedTail,
			}),
		};
	}

	async commitPayload(
		model: Model<any>,
		result: BeforeProviderPayloadEventResult,
		attribution: ProviderPayloadAttribution,
	): Promise<unknown> {
		const proposal = result.compaction;
		if (proposal === undefined) {
			return result.payload;
		}
		if (attribution.origin !== "agent" || attribution.compaction === undefined) {
			throw new Error("Inline compaction proposals are only allowed for agent-origin provider requests");
		}

		const token = proposal.token as object;
		const snapshot = this.#snapshots.get(token);
		if (!snapshot) {
			throw new Error("Inline compaction proposal used a stale or forged commit token");
		}
		if (snapshot.consumed) {
			throw new Error("Inline compaction proposal reused a consumed commit token");
		}
		if (
			snapshot.sessionId !== attribution.sessionId ||
			snapshot.providerId !== model.provider ||
			snapshot.modelId !== model.id
		) {
			throw new Error("Inline compaction proposal did not match the current request snapshot");
		}
		if (attribution.signal.aborted) {
			throw new Error("Compaction cancelled");
		}
		const currentLeafId = this.#sessionManager.getLeafId();
		if (currentLeafId !== snapshot.leafId) {
			throw new Error("Inline compaction proposal became stale before commit");
		}

		const preparation = prepareCompaction(
			this.#sessionManager.getBranch(),
			this.#settingsManager.getCompactionSettings(),
		);
		if (!preparation) {
			throw new Error("Inline compaction proposal no longer matches the active branch");
		}
		if (
			preparation.firstKeptEntryId !== snapshot.firstKeptEntryId ||
			!isDeepStrictEqual(preparation.retainedTail, snapshot.retainedTail)
		) {
			throw new Error("Inline compaction proposal did not match Pi's retained-tail snapshot");
		}

		const summary = normalizeSummary(proposal.summary);
		const tokensBefore = normalizeTokensBefore(proposal.tokensBefore);
		const usage = proposal.usage as Usage | undefined;

		snapshot.consumed = true;
		const parentId = snapshot.leafId;
		const retainedTail = [...preparation.retainedTail];
		let compactionEntryId: string | undefined;
		try {
			compactionEntryId = this.#sessionManager.appendCompaction(
				summary,
				preparation.firstKeptEntryId,
				tokensBefore,
				proposal.details,
				true,
				usage,
				retainedTail,
			);
			const savedEntry = this.#sessionManager.getEntry(compactionEntryId);
			if (
				savedEntry?.type !== "compaction" ||
				savedEntry.id !== compactionEntryId ||
				savedEntry.parentId !== parentId ||
				savedEntry.summary !== summary ||
				savedEntry.firstKeptEntryId !== preparation.firstKeptEntryId ||
				savedEntry.tokensBefore !== tokensBefore ||
				!isDeepStrictEqual(savedEntry.details, proposal.details) ||
				!isDeepStrictEqual(savedEntry.usage, usage) ||
				!isDeepStrictEqual(savedEntry.retainedTail, retainedTail)
			) {
				throw new Error("Inline compaction commit could not be verified after append");
			}
			await this.#extensionRunnerRef.current?.emitCompactionTransactionEvent({
				type: "session_compact",
				compactionEntry: savedEntry,
				fromExtension: true,
				reason: "provider_inline",
				trigger: "provider_inline",
				willRetry: false,
			});
		} catch (error) {
			try {
				await this.#extensionRunnerRef.current?.emitCompactionTransactionEvent({
					type: "session_compact_indeterminate",
					...(compactionEntryId === undefined ? {} : { entryId: compactionEntryId }),
					trigger: "provider_inline",
				});
			} catch {
				// Preserve the original transaction failure.
			}
			throw error;
		}
		return result.payload;
	}
}
