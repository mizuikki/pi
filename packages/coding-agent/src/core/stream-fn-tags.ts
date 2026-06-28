import type { StreamFn } from "@mizuikki/pi-agent-core";

export const SDK_DEFAULT_STREAM_FN = Symbol.for("pi.coding-agent.sdkDefaultStreamFn");

type TaggedStreamFn = StreamFn & {
	[SDK_DEFAULT_STREAM_FN]?: true;
};

export function markSdkDefaultStreamFn(streamFn: StreamFn): StreamFn {
	return Object.assign(streamFn, { [SDK_DEFAULT_STREAM_FN]: true as const });
}

export function isSdkDefaultStreamFn(streamFn: StreamFn): boolean {
	return (streamFn as TaggedStreamFn)[SDK_DEFAULT_STREAM_FN] === true;
}
