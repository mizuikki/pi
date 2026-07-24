import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	createNodeSqliteFactory,
	SqliteSessionStorage,
} from "../../../storage/sqlite-node/src/index.ts";
import { Session } from "../../src/harness/session/session.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("sqlite-node adapter", () => {
	it("supports node:sqlite-style named parameters", async () => {
		const root = createTempDir();
		const databasePath = join(root, "adapter.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
			await db.prepare("INSERT INTO items (id, text) VALUES ($id, $text)").run({ $id: 1, $text: "hello" });
			const row = await db.prepare("SELECT text FROM items WHERE id = $id").get<{ text: string }>({ $id: 1 });
			expect(row).toEqual({ text: "hello" });
		} finally {
			await db.close();
		}
	});

	it("reconstructs full paths across retained-tail compaction entries", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await applyMigrations(db);
			const storage = await SqliteSessionStorage.create(db, databasePath, {
				cwd: root,
				sessionId: "session-1",
			});
			await storage.appendEntry({
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: createUserMessage("root"),
			});
			await storage.appendEntry({
				type: "message",
				id: "child",
				parentId: "root",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: createAssistantMessage("child"),
			});
			await storage.appendEntry({
				type: "compaction",
				id: "compaction",
				parentId: "child",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: "summary",
				firstKeptEntryId: "child",
				tokensBefore: 10,
				retainedTail: [createAssistantMessage("child")],
			});
			await storage.appendEntry({
				type: "message",
				id: "after",
				parentId: "compaction",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: createUserMessage("after"),
			});

			expect((await storage.getPathToRootOrCompaction("after")).map((entry) => entry.id)).toEqual([
				"compaction",
				"after",
			]);
			expect((await storage.getPathToRoot("after")).map((entry) => entry.id)).toEqual([
				"root",
				"child",
				"compaction",
				"after",
			]);
			const session = new Session(storage);
			expect((await session.getFullActivePathSnapshot("after")).map((entry) => entry.id)).toEqual([
				"root",
				"child",
				"compaction",
				"after",
			]);
		} finally {
			await db.close();
		}
	});
});
