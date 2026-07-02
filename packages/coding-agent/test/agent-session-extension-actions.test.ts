import { describe, expect, it, vi } from "vitest";
import type { ExtensionError } from "../src/core/extensions/index.ts";
import { createHarness } from "./suite/harness.ts";

type SessionWithExtensionActionInternals = {
	_extensionActionPromises: Set<Promise<void>>;
	_waitForExtensionActions(reason: "startup" | "reload"): Promise<void>;
	_didExtensionActionWaitTimeout(remainingMs: number): Promise<boolean>;
	extensionRunner: { emitError(error: ExtensionError): void };
};

describe("AgentSession extension action waits", () => {
	it("clears timed-out extension actions before the next wait cycle", async () => {
		const harness = await createHarness();

		try {
			const session = harness.session as unknown as SessionWithExtensionActionInternals;
			const originalDidTimeout = session._didExtensionActionWaitTimeout.bind(session);
			const pending = new Promise<void>(() => {});
			const errors: string[] = [];
			const emitErrorSpy = vi
				.spyOn(session.extensionRunner, "emitError")
				.mockImplementation((error: ExtensionError) => {
					errors.push(error.error);
				});

			session._extensionActionPromises.add(pending);
			session._didExtensionActionWaitTimeout = vi.fn(async () => true);

			await session._waitForExtensionActions("reload");

			expect(errors).toContain("Timed out waiting 30000ms for extension actions during reload");
			expect(session._extensionActionPromises.size).toBe(0);

			await session._waitForExtensionActions("reload");
			expect(errors).toHaveLength(1);

			session._didExtensionActionWaitTimeout = originalDidTimeout;
			emitErrorSpy.mockRestore();
		} finally {
			harness.cleanup();
		}
	});
});
