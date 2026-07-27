import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../catalog/types";
import {
	capOpenRouterAnthropicContextWindows,
	OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
} from "./openrouter-models";

function makeModel(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id,
		name: id,
		contextWindow: 1_000_000,
		maxInputTokens: 1_000_000,
		maxTokens: 64_000,
		...overrides,
	};
}

describe("capOpenRouterAnthropicContextWindows", () => {
	it("caps anthropic models that report an extended context window", () => {
		const result = capOpenRouterAnthropicContextWindows({
			"anthropic/claude-sonnet-4.5": makeModel("anthropic/claude-sonnet-4.5"),
		});

		expect(result["anthropic/claude-sonnet-4.5"]).toMatchObject({
			contextWindow: OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
			maxInputTokens: OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
			maxTokens: 64_000,
		});
	});

	it.each([
		"anthropic/claude-sonnet-4",
		"anthropic/claude-sonnet-4.6",
		"anthropic/claude-sonnet-5",
		"anthropic/claude-opus-4.6",
		"anthropic/claude-opus-4.7",
		"anthropic/claude-opus-4.7-fast",
		"anthropic/claude-opus-4.8",
		"anthropic/claude-fable-5",
	])("caps %s", (id) => {
		const result = capOpenRouterAnthropicContextWindows({
			[id]: makeModel(id),
		});
		expect(result[id]?.contextWindow).toBe(
			OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
		);
		expect(result[id]?.maxInputTokens).toBe(
			OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
		);
	});

	it("leaves anthropic models at or under the cap unchanged", () => {
		const model = makeModel("anthropic/claude-opus-4.5", {
			contextWindow: 200_000,
			maxInputTokens: 200_000,
		});
		const result = capOpenRouterAnthropicContextWindows({
			"anthropic/claude-opus-4.5": model,
		});
		expect(result["anthropic/claude-opus-4.5"]).toBe(model);
	});

	it("leaves non-anthropic extended-context models unchanged", () => {
		const model = makeModel("qwen/qwen3-coder-next-fp8-1m");
		const result = capOpenRouterAnthropicContextWindows({
			"qwen/qwen3-coder-next-fp8-1m": model,
		});
		expect(result["qwen/qwen3-coder-next-fp8-1m"]?.contextWindow).toBe(
			1_000_000,
		);
	});

	it("caps maxInputTokens even when contextWindow is under the cap", () => {
		const result = capOpenRouterAnthropicContextWindows({
			"anthropic/claude-sonnet-4.5": makeModel("anthropic/claude-sonnet-4.5", {
				contextWindow: 200_000,
				maxInputTokens: 1_000_000,
			}),
		});
		expect(result["anthropic/claude-sonnet-4.5"]).toMatchObject({
			contextWindow: 200_000,
			maxInputTokens: OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP,
		});
	});

	it("preserves models without reported limits", () => {
		const model = makeModel("anthropic/claude-3-haiku", {
			contextWindow: undefined,
			maxInputTokens: undefined,
		});
		const result = capOpenRouterAnthropicContextWindows({
			"anthropic/claude-3-haiku": model,
		});
		expect(result["anthropic/claude-3-haiku"]).toBe(model);
	});

	it("does not mutate the input models", () => {
		const model = makeModel("anthropic/claude-sonnet-4.5");
		const snapshot = structuredClone(model);
		capOpenRouterAnthropicContextWindows({
			"anthropic/claude-sonnet-4.5": model,
		});
		expect(model).toEqual(snapshot);
	});

	it("is idempotent", () => {
		const once = capOpenRouterAnthropicContextWindows({
			"anthropic/claude-sonnet-4.5": makeModel("anthropic/claude-sonnet-4.5"),
		});
		const twice = capOpenRouterAnthropicContextWindows(once);
		expect(twice).toEqual(once);
	});
});
