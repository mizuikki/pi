import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { prepareCompaction } from "./compaction/index.ts";
import type {
	BeforeProviderPayloadEventResult,
	CompactionTrigger,
	ExtensionRunner,
	ProviderCheckpointProposal,
	ProviderCompactionCommitToken,
	ProviderPayloadAttribution,
	ProviderRequestOrigin,
} from "./extensions/index.ts";
import type { CustomEntry, SessionManager } from "./session-manager.ts";
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
			for (const item of Object.values(current as Record<string, unknown>)) stack.push(item);
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
	if (typeof tokensBefore !== "number" || !Number.isFinite(tokensBefore) || tokensBefore < 0) {
		throw new Error("Compaction proposals must include a finite non-negative token count");
	}
	return Math.trunc(tokensBefore);
}

function normalizeCheckpointField(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		value.trim().length === 0 ||
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new Error(`Provider checkpoint ${label} is invalid`);
	}
	return value;
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
		if (origin !== "agent") return { sessionId, origin, signal };
		const leafId = this.#sessionManager.getLeafId();
		if (leafId === null) return { sessionId, origin, signal };
		const preparation = prepareCompaction(
			this.#sessionManager.getBranch(),
			this.#settingsManager.getCompactionSettings(),
		);
		if (!preparation) return { sessionId, origin, signal };

		const token = this.#createToken({
			sessionId,
			providerId: model.provider,
			modelId: model.id,
			leafId,
			firstKeptEntryId: preparation.firstKeptEntryId,
			retainedTail: preparation.retainedTail,
		});
		const candidateRetainedTail = cloneAndFreezeMessages(preparation.retainedTail);
		return {
			sessionId,
			origin,
			signal,
			compaction: Object.freeze({ token, candidateLeafId: leafId, candidateRetainedTail }),
		};
	}

	/** Commit a manual or overflow provider checkpoint using the token on the compact event. */
	async commitProviderCheckpoint(
		model: Model<any>,
		proposal: ProviderCheckpointProposal,
		expectedToken: ProviderCompactionCommitToken | undefined,
		signal: AbortSignal,
		trigger: CompactionTrigger,
		willRetry: boolean,
	): Promise<CustomEntry> {
		this.#assertProposalToken(proposal.token, expectedToken);
		const snapshot = this.#lookupSnapshot(proposal.token, model, signal);
		this.#assertCurrentPreparation(snapshot);
		return this.#appendProviderCheckpoint(proposal, snapshot, signal, trigger, willRetry);
	}

	async commitPayload(
		model: Model<any>,
		result: BeforeProviderPayloadEventResult,
		attribution: ProviderPayloadAttribution,
	): Promise<unknown> {
		if (result.compaction !== undefined && result.providerCheckpoint !== undefined) {
			throw new Error("Provider compaction and checkpoint proposals are mutually exclusive");
		}
		if (result.providerCheckpoint !== undefined) {
			if (attribution.origin !== "agent" || attribution.compaction === undefined) {
				throw new Error("Provider checkpoint proposals are only allowed for agent-origin requests");
			}
			this.#assertProposalToken(result.providerCheckpoint.token, attribution.compaction.token);
			const snapshot = this.#lookupSnapshot(result.providerCheckpoint.token, model, attribution.signal);
			this.#assertCurrentPreparation(snapshot);
			await this.#appendProviderCheckpoint(
				result.providerCheckpoint,
				snapshot,
				attribution.signal,
				"provider_inline",
				false,
			);
			return result.payload;
		}

		const proposal = result.compaction;
		if (proposal === undefined) return result.payload;
		if (attribution.origin !== "agent" || attribution.compaction === undefined) {
			throw new Error("Inline compaction proposals are only allowed for agent-origin provider requests");
		}
		this.#assertProposalToken(proposal.token, attribution.compaction.token);
		const snapshot = this.#lookupSnapshot(proposal.token, model, attribution.signal);
		this.#assertCurrentPreparation(snapshot);

		const summary = normalizeSummary(proposal.summary);
		const tokensBefore = normalizeTokensBefore(proposal.tokensBefore);
		const usage = proposal.usage as Usage | undefined;
		snapshot.consumed = true;
		const parentId = snapshot.leafId;
		const retainedTail = [...snapshot.retainedTail];
		let compactionEntryId: string | undefined;
		let savedEntry: ReturnType<SessionManager["getEntry"]>;
		try {
			compactionEntryId = this.#sessionManager.appendCompaction(
				summary,
				snapshot.firstKeptEntryId,
				tokensBefore,
				proposal.details,
				true,
				usage,
				retainedTail,
			);
			savedEntry = this.#sessionManager.getEntry(compactionEntryId);
			if (
				savedEntry?.type !== "compaction" ||
				savedEntry.id !== compactionEntryId ||
				savedEntry.parentId !== parentId ||
				savedEntry.summary !== summary ||
				savedEntry.firstKeptEntryId !== snapshot.firstKeptEntryId ||
				savedEntry.tokensBefore !== tokensBefore ||
				!isDeepStrictEqual(savedEntry.details, proposal.details) ||
				!isDeepStrictEqual(savedEntry.usage, usage) ||
				!isDeepStrictEqual(savedEntry.retainedTail, retainedTail)
			) {
				throw new Error("Inline compaction commit could not be verified after append");
			}
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
		await this.#extensionRunnerRef.current?.emitCompactionTransactionEvent({
			type: "session_compact",
			compactionEntry: savedEntry!,
			fromExtension: true,
			reason: "provider_inline",
			trigger: "provider_inline",
			willRetry: false,
		});
		return result.payload;
	}

	#lookupSnapshot(
		token: ProviderCompactionCommitToken,
		model: Model<any>,
		signal: AbortSignal,
	): ProviderInlineCompactionSnapshot {
		const snapshot = this.#snapshots.get(token as object);
		if (snapshot === undefined) throw new Error("Provider checkpoint used a stale or forged commit token");
		if (snapshot.consumed) throw new Error("Provider checkpoint reused a consumed commit token");
		if (
			snapshot.sessionId !== this.#sessionManager.getSessionId() ||
			snapshot.providerId !== model.provider ||
			snapshot.modelId !== model.id
		) {
			throw new Error("Provider checkpoint did not match the current request snapshot");
		}
		if (signal.aborted) throw new Error("Compaction cancelled");
		if (this.#sessionManager.getLeafId() !== snapshot.leafId) {
			throw new Error("Provider checkpoint became stale before commit");
		}
		return snapshot;
	}

	#assertProposalToken(
		proposalToken: ProviderCompactionCommitToken,
		expectedToken: ProviderCompactionCommitToken | undefined,
	): void {
		if (expectedToken === undefined || proposalToken !== expectedToken) {
			throw new Error("Provider checkpoint proposal did not match the active request token");
		}
	}

	#assertCurrentPreparation(snapshot: ProviderInlineCompactionSnapshot): void {
		const preparation = prepareCompaction(
			this.#sessionManager.getBranch(),
			this.#settingsManager.getCompactionSettings(),
		);
		if (
			preparation === undefined ||
			preparation.firstKeptEntryId !== snapshot.firstKeptEntryId ||
			!isDeepStrictEqual(preparation.retainedTail, snapshot.retainedTail)
		) {
			throw new Error("Provider checkpoint no longer matches the active branch");
		}
	}

	async #appendProviderCheckpoint(
		proposal: ProviderCheckpointProposal,
		snapshot: ProviderInlineCompactionSnapshot,
		signal: AbortSignal,
		trigger: CompactionTrigger,
		willRetry: boolean,
	): Promise<CustomEntry> {
		const customType = normalizeCheckpointField(proposal.customType, "custom type");
		const checkpointId = normalizeCheckpointField(proposal.checkpointId, "ID");
		if (signal.aborted) throw new Error("Compaction cancelled");
		snapshot.consumed = true;
		let entryId: string | undefined;
		try {
			entryId = this.#sessionManager.appendCustomEntry(customType, proposal.data);
			const savedEntry = this.#sessionManager.getEntry(entryId);
			if (
				savedEntry?.type !== "custom" ||
				savedEntry.id !== entryId ||
				savedEntry.parentId !== snapshot.leafId ||
				savedEntry.customType !== customType ||
				!isDeepStrictEqual(savedEntry.data, proposal.data)
			) {
				throw new Error("Provider checkpoint append could not be verified after append");
			}
			const extensionRunner = this.#extensionRunnerRef.current;
			if (extensionRunner !== undefined && !extensionRunner.setProviderCheckpointUsageBoundary(entryId)) {
				throw new Error("Provider checkpoint usage boundary could not be recorded");
			}
			await this.#extensionRunnerRef.current?.emitCompactionTransactionEvent({
				type: "session_provider_checkpoint",
				entry: savedEntry,
				checkpointId,
				trigger,
				willRetry,
			});
			return savedEntry;
		} catch (error) {
			try {
				await this.#extensionRunnerRef.current?.emitCompactionTransactionEvent({
					type: "session_provider_checkpoint_indeterminate",
					...(entryId === undefined ? {} : { entryId }),
					checkpointId,
					trigger,
				});
			} catch {
				// Preserve the original transaction failure.
			}
			throw error;
		}
	}

	#createToken(snapshot: Omit<ProviderInlineCompactionSnapshot, "consumed">): ProviderCompactionCommitToken {
		const token = Object.freeze({
			[providerCompactionTokenRuntimeBrand]: true,
		}) as unknown as ProviderCompactionCommitToken;
		this.#snapshots.set(token as object, { ...snapshot, consumed: false });
		return token;
	}
}
