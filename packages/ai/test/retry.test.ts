import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "response transmission aborted: billing limit reached",
				}),
			),
		).toBe(false);
	});

	it("classifies assistant transport failures", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "stream_read_error" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "Model stream error" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "STREAM_UPSTREAM_ABORTED" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "OpenAI Responses stream ended before a terminal response event",
				}),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "upstream request was aborted" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "aborted",
					errorMessage: "request was aborted while reading response",
				}),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "response transmission aborted" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Operation aborted" }),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "model gpt-500-preview is unavailable" }),
			),
		).toBe(false);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});
