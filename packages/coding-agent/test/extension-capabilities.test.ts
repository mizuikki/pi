import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, HostRetryPolicySnapshot } from "../src/index.ts";

const acceptsRetryPolicySnapshot = (_snapshot: HostRetryPolicySnapshot): void => {};

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

		expect(api?.extensionSdkApiVersion).toBe(1);
		expect(api?.modelRuntimeApiVersion).toBe(1);
		expect(api?.retryPolicySnapshotApiVersion).toBe(1);
		expect(api?.providerPayloadCompactionApiVersion).toBe(1);
		expect(api?.compactionFailureResultApiVersion).toBe(1);
	});

	it("exports the retry policy snapshot from the package barrel", () => {
		expect(acceptsRetryPolicySnapshot).toBeTypeOf("function");
	});
});
