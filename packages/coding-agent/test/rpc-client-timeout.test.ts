import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientInternals = {
	handleLine(line: string): void;
};

function emitAgentEnd(client: RpcClient): void {
	(client as unknown as RpcClientInternals).handleLine(JSON.stringify({ type: "agent_end" }));
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("RpcClient wait timeout behavior", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("waits past 60s by default and resolves when agent_end arrives", async () => {
		const client = new RpcClient();
		const promise = client.waitForIdle();

		setTimeout(() => emitAgentEnd(client), 61_000);

		await vi.advanceTimersByTimeAsync(61_000);
		await expect(promise).resolves.toBeUndefined();
	});

	it("uses RpcClientOptions.waitTimeoutMs when no per-call timeout is provided", async () => {
		const client = new RpcClient({ waitTimeoutMs: 25 });
		const promise = client.waitForIdle().catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(25);
		await expect(promise).resolves.toBeInstanceOf(Error);
		await expect(promise).resolves.toHaveProperty(
			"message",
			expect.stringContaining("Timeout waiting for agent to become idle"),
		);
	});

	it("collectEvents waits past 60s by default and resolves with the final agent_end event", async () => {
		const client = new RpcClient();
		const promise = client.collectEvents();

		setTimeout(() => emitAgentEnd(client), 61_000);

		await vi.advanceTimersByTimeAsync(61_000);
		await expect(promise).resolves.toEqual([{ type: "agent_end" }]);
	});

	it("promptAndWait waits past 60s by default and resolves after prompt completes", async () => {
		const client = new RpcClient();
		vi.spyOn(client, "prompt").mockResolvedValue(undefined);

		const promise = client.promptAndWait("hello");
		setTimeout(() => emitAgentEnd(client), 61_000);

		await vi.advanceTimersByTimeAsync(61_000);
		await expect(promise).resolves.toEqual([{ type: "agent_end" }]);
	});
});
