import { capOpenRouterAnthropicContextWindows } from "../providers/openrouter-models";
import { GENERATED_PROVIDER_MODELS } from "./catalog.generated";
import { sortModelsByReleaseDate } from "./catalog-live";
import type { ModelInfo } from "./types";

let sortedGeneratedProviderModelsCache:
	| Record<string, Record<string, ModelInfo>>
	| undefined;
const sortedGeneratedModelsByProviderCache = new Map<
	string,
	Record<string, ModelInfo>
>();

// The generated catalog preserves provider-reported values; product policy
// (e.g. the OpenRouter Anthropic 200K context cap) is applied here at the
// runtime access boundary so every consumer sees consistent model info.
function applyModelAccessPolicies(
	providerId: string,
	models: Record<string, ModelInfo>,
): Record<string, ModelInfo> {
	if (providerId === "openrouter") {
		return capOpenRouterAnthropicContextWindows(models);
	}
	return models;
}

export function getGeneratedProviderModels(): Record<
	string,
	Record<string, ModelInfo>
> {
	sortedGeneratedProviderModelsCache ??= Object.fromEntries(
		Object.entries(GENERATED_PROVIDER_MODELS.providers).map(
			([providerId, models]) => [
				providerId,
				sortModelsByReleaseDate(applyModelAccessPolicies(providerId, models)),
			],
		),
	);
	return sortedGeneratedProviderModelsCache;
}

export function getGeneratedModelsVersion(): number {
	return GENERATED_PROVIDER_MODELS.version;
}

export function getGeneratedModelsForProvider(
	providerId: string,
): Record<string, ModelInfo> {
	const cached = sortedGeneratedModelsByProviderCache.get(providerId);
	if (cached) {
		return cached;
	}
	const sorted = sortModelsByReleaseDate(
		applyModelAccessPolicies(
			providerId,
			GENERATED_PROVIDER_MODELS.providers[providerId] ?? {},
		),
	);
	sortedGeneratedModelsByProviderCache.set(providerId, sorted);
	return sorted;
}
