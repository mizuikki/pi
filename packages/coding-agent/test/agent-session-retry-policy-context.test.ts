import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

describe("AgentSession retry policy extension context", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("binds fresh active snapshots to production event and command contexts without writing settings", async () => {
		harness = await createHarnessWithExtensions({ extensionFactories: [() => {}] });
		await harness.session.bindExtensions({});

		const settingsPath = join(harness.tempDir, "settings.json");
		writeFileSync(settingsPath, '{"theme":"dark"}\n');
		const beforeBytes = readFileSync(settingsPath);
		const beforeMtime = statSync(settingsPath).mtimeMs;

		const eventContext: ExtensionContext = harness.session.extensionRunner.createContext();
		const commandContext = harness.session.extensionRunner.createCommandContext();
		expect(eventContext.getRetryPolicy).toBeTypeOf("function");
		expect(commandContext.getRetryPolicy).toBeTypeOf("function");

		const first = eventContext.getRetryPolicy?.();
		expect(first).toEqual({
			agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
			providerRequest: { timeoutMs: undefined, maxRetries: undefined, maxRetryDelayMs: 60000 },
		});

		harness.settingsManager.applyOverrides({
			retry: {
				enabled: false,
				maxRetries: 7,
				baseDelayMs: 25,
				provider: { timeoutMs: 9000, maxRetries: 4, maxRetryDelayMs: 1500 },
			},
		});
		const second = commandContext.getRetryPolicy?.();
		expect(second).toEqual({
			agentTurn: { enabled: false, maxRetries: 7, baseDelayMs: 25 },
			providerRequest: { timeoutMs: 9000, maxRetries: 4, maxRetryDelayMs: 1500 },
		});
		expect(second).not.toBe(first);
		expect(second?.agentTurn).not.toBe(first?.agentTurn);
		expect(second?.providerRequest).not.toBe(first?.providerRequest);

		if (second) {
			second.agentTurn.maxRetries = 99;
			second.providerRequest.maxRetries = 99;
		}
		expect(eventContext.getRetryPolicy?.().agentTurn.maxRetries).toBe(7);
		expect(eventContext.getRetryPolicy?.().providerRequest.maxRetries).toBe(4);
		expect(readFileSync(settingsPath)).toEqual(beforeBytes);
		expect(statSync(settingsPath).mtimeMs).toBe(beforeMtime);
	});
});
