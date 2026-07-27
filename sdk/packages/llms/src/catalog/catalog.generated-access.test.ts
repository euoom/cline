import { describe, expect, it } from "vitest";
import { OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP } from "../providers/openrouter-models";
import { GENERATED_PROVIDER_MODELS } from "./catalog.generated";
import {
	getGeneratedModelsForProvider,
	getGeneratedProviderModels,
} from "./catalog.generated-access";

describe("generated catalog access policies", () => {
	it("caps OpenRouter anthropic models to the standard context window", () => {
		const models = getGeneratedModelsForProvider("openrouter");
		const sonnet = models["anthropic/claude-sonnet-4.5"];

		expect(sonnet).toBeDefined();
		expect(sonnet?.contextWindow).toBe(OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP);
		expect(sonnet?.maxInputTokens).toBe(
			OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
		);
	});

	it("caps the openrouter entry of the full provider record", () => {
		const models = getGeneratedProviderModels().openrouter ?? {};
		for (const [id, model] of Object.entries(models)) {
			if (!id.startsWith("anthropic/")) {
				continue;
			}
			expect(
				model.contextWindow ?? 0,
				`${id} contextWindow`,
			).toBeLessThanOrEqual(OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP);
			expect(
				model.maxInputTokens ?? 0,
				`${id} maxInputTokens`,
			).toBeLessThanOrEqual(OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP);
		}
	});

	it("does not modify the raw generated catalog data", () => {
		expect(
			GENERATED_PROVIDER_MODELS.providers.openrouter?.[
				"anthropic/claude-sonnet-4.5"
			]?.contextWindow,
		).toBe(1_000_000);
	});

	it("leaves non-anthropic extended-context models untouched", () => {
		const models = getGeneratedModelsForProvider("openrouter");
		expect(models["x-ai/grok-4.3"]?.contextWindow).toBe(1_000_000);
	});
});
