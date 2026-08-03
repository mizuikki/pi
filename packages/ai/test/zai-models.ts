import { getModels } from "../src/compat.ts";
import type { Api, Model, OpenAICompletionsCompat } from "../src/types.ts";

const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

const ZAI_TEST_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	thinkingFormat: "zai",
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
} satisfies OpenAICompletionsCompat;

/**
 * Resolve a live z.ai model without coupling tests to a generated model ID.
 * The catalog is refreshed from models.dev during builds, so historical IDs
 * may legitimately be absent when a provider retires a model.
 */
export function getZaiModel(preferredIds: readonly string[] = []): Model<Api> | undefined {
	const models = getModels("zai");
	for (const id of preferredIds) {
		const model = models.find((candidate) => candidate.id === id);
		if (model) return model;
	}
	return undefined;
}

export function createZaiTestModel(
	id: string,
	options: {
		zaiToolStream?: boolean;
		supportsReasoningEffort?: boolean;
		thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
	} = {},
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "zai",
		baseUrl: ZAI_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: {
			...ZAI_TEST_COMPAT,
			...(options.zaiToolStream === undefined ? {} : { zaiToolStream: options.zaiToolStream }),
			...(options.supportsReasoningEffort === undefined
				? {}
				: { supportsReasoningEffort: options.supportsReasoningEffort }),
		},
		thinkingLevelMap: options.thinkingLevelMap,
	};
}
