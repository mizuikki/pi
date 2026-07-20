import type { Model } from "@earendil-works/pi-ai/compat";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type TestInteractiveMode = {
	session: {
		scopedModels: Array<{ model: Model<any> }>;
		modelRuntime: {
			getAvailable: () => Promise<Model<any>[]>;
		};
		promptTemplates: [];
		extensionRunner: { getRegisteredCommands: () => [] };
		resourceLoader: { getSkills: () => { skills: [] } };
	};
	settingsManager: { getEnableSkillCommands: () => boolean };
	skillCommands: Map<string, string>;
	sessionManager: { getCwd: () => string };
	fdPath: undefined;
};

describe("InteractiveMode model autocomplete", () => {
	it("uses async available models for /model completions", async () => {
		const explicitModel = {
			provider: "explicit-faux",
			id: "faux-1",
			api: "faux",
			name: "Explicit Faux",
			baseUrl: "http://localhost:0",
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} satisfies Model<"faux">;
		const getAvailable = vi.fn(async () => [explicitModel]);
		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: TestInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const fakeThis: TestInteractiveMode = {
			session: {
				scopedModels: [],
				modelRuntime: {
					getAvailable,
				},
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: undefined,
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const line = "/model faux";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(getAvailable).toHaveBeenCalledTimes(1);
		expect(suggestions?.items.map((item) => item.value)).toEqual(["explicit-faux/faux-1"]);
	});
});
