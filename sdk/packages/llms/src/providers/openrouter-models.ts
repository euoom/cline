import type { ModelInfo } from "../catalog/types";

/**
 * Cline product policy for OpenRouter-routed Anthropic Claude models.
 *
 * OpenRouter (and models.dev) advertise the Anthropic 1M-token
 * extended-context beta as these models' context window. Cline
 * intentionally restricts them to the standard 200K window: Anthropic
 * bills long-context requests (>200K input tokens) at premium rates, so
 * letting the context grow past 200K silently moves users onto premium
 * pricing and skews context-percentage and auto-compaction thresholds.
 * This mirrors the legacy extension's OpenRouter catalog behavior.
 *
 * This is runtime access policy, not catalog data: the generated catalog
 * and the models.dev normalizer keep the provider-reported values (see
 * `src/catalog/README.md`).
 */
export const OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP = 200_000;

const OPENROUTER_ANTHROPIC_MODEL_ID_PREFIX = "anthropic/";

function exceedsCap(value: number | undefined): boolean {
	return (
		typeof value === "number" && value > OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP
	);
}

function isCappedOpenRouterModel(id: string, model: ModelInfo): boolean {
	return (
		id.startsWith(OPENROUTER_ANTHROPIC_MODEL_ID_PREFIX) &&
		(exceedsCap(model.contextWindow) || exceedsCap(model.maxInputTokens))
	);
}

function toCappedModel(model: ModelInfo): ModelInfo {
	return {
		...model,
		contextWindow: exceedsCap(model.contextWindow)
			? OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP
			: model.contextWindow,
		maxInputTokens: exceedsCap(model.maxInputTokens)
			? OPENROUTER_ANTHROPIC_CONTEXT_WINDOW_CAP
			: model.maxInputTokens,
	};
}

/**
 * Caps every `anthropic/*` model in an OpenRouter model record to the
 * 200K standard context window. Non-Anthropic models and models already
 * at or under the cap pass through unchanged. Does not mutate the input.
 */
export function capOpenRouterAnthropicContextWindows(
	models: Record<string, ModelInfo>,
): Record<string, ModelInfo> {
	const result: Record<string, ModelInfo> = {};
	for (const [id, model] of Object.entries(models)) {
		result[id] = isCappedOpenRouterModel(id, model)
			? toCappedModel(model)
			: model;
	}
	return result;
}
