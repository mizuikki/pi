import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";

describe("provider payload compaction host capability", () => {
	it("exposes the transaction API version to extension factories", async () => {
		let version: number | undefined;
		await loadExtensionFromFactory(
			(pi) => {
				version = pi.providerPayloadCompactionApiVersion;
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(version).toBe(1);
	});
});
