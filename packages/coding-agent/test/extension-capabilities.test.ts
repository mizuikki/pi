import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

describe("ExtensionAPI capabilities", () => {
	it("exposes the private runtime contract versions to factories", async () => {
		let api: ExtensionAPI | undefined;
		await loadExtensionFromFactory(
			(value) => {
				api = value;
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(api?.modelRuntimeApiVersion).toBe(1);
		expect(api?.providerPayloadCompactionApiVersion).toBe(1);
	});
});
