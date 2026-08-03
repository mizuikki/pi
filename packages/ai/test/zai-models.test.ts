import { describe, expect, it } from "vitest";
import { getZaiModel } from "./zai-models.ts";

describe("z.ai test model selection", () => {
	it("does not substitute an arbitrary model when preferred IDs are unavailable", () => {
		expect(getZaiModel(["__missing_zai_test_model__"])).toBeUndefined();
	});
});
