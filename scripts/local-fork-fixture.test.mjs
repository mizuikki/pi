import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLocalSdkManifest } from "./local-fork-fixture.mjs";

test("readLocalSdkManifest rejects duplicate SDK package names", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-sdk-manifest-test-"));
	const manifestPath = join(directory, "pi-sdk-manifest.json");

	try {
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: 1,
				sdkVersion: "0.81.1-local.1",
				packages: [
					{ name: "@earendil-works/pi-ai" },
					{ name: "@earendil-works/pi-ai" },
					{ name: "@earendil-works/pi-agent-core" },
					{ name: "@earendil-works/pi-coding-agent" },
				],
			}),
		);

		assert.throws(() => readLocalSdkManifest(manifestPath), /exactly the four expected packages/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
