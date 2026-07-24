import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("prefers retainedTail when rebuilding compacted session context", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "root" }],
			timestamp: 1,
		});
		const keptAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "kept assistant" }],
			api: "faux",
			provider: "faux",
			model: "test-model",
			stopReason: "stop" as const,
			timestamp: 2,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const keptAssistantId = session.appendMessage(keptAssistant);
		session.appendCompaction("summary", rootId, 10, undefined, false, undefined, [keptAssistant]);
		session.appendMessage({
			role: "user",
			content: [{ type: "text" as const, text: "after compaction" }],
			timestamp: 3,
		});

		const contextEntries = session.buildContextEntries();
		expect(contextEntries.map((entry) => entry.id)).toEqual([expect.any(String), expect.any(String)]);

		const context = session.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary", "assistant", "user"]);
		const compactionEntry = session.getEntries().find((entry) => entry.type === "compaction");
		expect(compactionEntry?.type === "compaction" ? compactionEntry.firstKeptEntryId : undefined).toBe(rootId);
		expect(keptAssistantId).toBeDefined();
	});

	it("reads legacy v3 session files without rewriting them in place", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compaction-session-"));
		try {
			const filePath = join(dir, "session.jsonl");
			const original = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "session-1",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: dir,
				}),
				JSON.stringify({
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
						timestamp: 1,
					},
				}),
				JSON.stringify({
					type: "compaction",
					id: "compaction-1",
					parentId: "user-1",
					timestamp: "2026-01-01T00:00:02.000Z",
					summary: "summary",
					firstKeptEntryId: "user-1",
					tokensBefore: 5,
				}),
			].join("\n");
			writeFileSync(filePath, `${original}\n`);

			const session = SessionManager.open(filePath);
			expect(session.buildContextEntries().map((entry) => entry.type)).toEqual(["compaction", "message"]);
			expect(readFileSync(filePath, "utf8")).toBe(`${original}\n`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
