import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("provider checkpoint HTML export", () => {
	it("keeps navigation metadata while removing opaque checkpoint data", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-provider-checkpoint-export-"));
		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage(userMsg("before"));
			session.appendMessage(assistantMsg("response"));
			session.appendCustomEntry(
				"fixture.provider-checkpoint",
				{ sentinel: "OPAQUE_CHECKPOINT_PAYLOAD_SENTINEL" },
				{ role: "provider_checkpoint", tokensBefore: 12_600 },
			);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			const outputPath = join(tempDir, "session.html");

			await exportFromFile(sessionFile!, outputPath);

			const html = readFileSync(outputPath, "utf8");
			const encodedData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			expect(encodedData).toBeDefined();
			const exported = JSON.parse(Buffer.from(encodedData!, "base64").toString("utf8")) as {
				entries: Array<{ type: string; data?: unknown; navigation?: unknown }>;
			};
			const checkpoint = exported.entries.find((entry) => entry.type === "custom");
			expect(checkpoint).toMatchObject({
				navigation: { role: "provider_checkpoint", tokensBefore: 12_600 },
			});
			expect(checkpoint).not.toHaveProperty("data");
			expect(html).not.toContain("OPAQUE_CHECKPOINT_PAYLOAD_SENTINEL");
			expect(html).toContain("[provider checkpoint:");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
