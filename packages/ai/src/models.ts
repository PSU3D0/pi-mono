import { MODELS } from "./models.generated.js";
import type { Api, ContextTier, ContextTierPolicy, KnownProvider, Model, ModelCost, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

function sortContextTiers(tiers: ContextTier[]): ContextTier[] {
	return [...tiers].sort((a, b) => a.contextWindow - b.contextWindow);
}

function buildDefaultContextTier<TApi extends Api>(model: Model<TApi>): ContextTier {
	return {
		id: "default",
		name: "Default",
		contextWindow: model.contextWindow,
		costMultiplier: 1,
		default: true,
	};
}

function multiplyCost(cost: ModelCost, multiplier: number): ModelCost {
	return {
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
	};
}

function formatRatio(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, "");
}

export function getContextTiers<TApi extends Api>(model: Model<TApi>): ContextTier[] {
	const tiers =
		model.contextTiers && model.contextTiers.length > 0 ? model.contextTiers : [buildDefaultContextTier(model)];
	const sorted = sortContextTiers(tiers);
	const hasExplicitDefault = sorted.some((tier) => tier.default);
	return sorted.map((tier, index) => ({
		...tier,
		costMultiplier: tier.costMultiplier ?? 1,
		default: hasExplicitDefault ? tier.default === true : index === 0,
	}));
}

export function getDefaultContextTier<TApi extends Api>(model: Model<TApi>): ContextTier {
	const tiers = getContextTiers(model);
	return tiers.find((tier) => tier.default) ?? tiers[0]!;
}

export function getMaxContextTier<TApi extends Api>(model: Model<TApi>): ContextTier {
	const tiers = getContextTiers(model);
	return tiers[tiers.length - 1]!;
}

export function normalizeModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	const contextTiers = getContextTiers(model);
	const defaultTier = contextTiers.find((tier) => tier.default) ?? contextTiers[0]!;
	return {
		...model,
		contextWindow: defaultTier.contextWindow,
		contextTiers,
	};
}

export function resolveContextTier<TApi extends Api>(
	model: Model<TApi>,
	policy: ContextTierPolicy,
	requiredTokens?: number,
): ContextTier {
	const tiers = getContextTiers(model);
	const defaultTier = getDefaultContextTier(model);
	const maxTier = tiers[tiers.length - 1]!;

	switch (policy) {
		case "default":
			return defaultTier;
		case "max":
			return maxTier;
		case "auto": {
			if (requiredTokens === undefined) {
				return defaultTier;
			}
			return tiers.find((tier) => requiredTokens <= tier.contextWindow) ?? maxTier;
		}
	}
}

export function getContextTierCost<TApi extends Api>(model: Model<TApi>, tier: ContextTier): ModelCost {
	if (tier.cost) {
		return {
			input: tier.cost.input ?? model.cost.input,
			output: tier.cost.output ?? model.cost.output,
			cacheRead: tier.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: tier.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	const multiplier = tier.costMultiplier ?? 1;
	return multiplier === 1 ? model.cost : multiplyCost(model.cost, multiplier);
}

export function getContextTierPriceIndicator<TApi extends Api>(
	model: Model<TApi>,
	tier: ContextTier,
): string | undefined {
	const baseCost = getContextTierCost(model, getDefaultContextTier(model));
	const tierCost = getContextTierCost(model, tier);
	const inputRatio = baseCost.input > 0 ? tierCost.input / baseCost.input : undefined;
	const outputRatio = baseCost.output > 0 ? tierCost.output / baseCost.output : undefined;

	const inputChanged = inputRatio !== undefined && Math.abs(inputRatio - 1) > 0.001;
	const outputChanged = outputRatio !== undefined && Math.abs(outputRatio - 1) > 0.001;

	if (!inputChanged && !outputChanged) {
		return undefined;
	}

	if (inputChanged && outputChanged && Math.abs(inputRatio! - outputRatio!) <= 0.001) {
		return `x${formatRatio(inputRatio!)}`;
	}

	const parts: string[] = [];
	if (inputChanged) parts.push(`↑x${formatRatio(inputRatio!)}`);
	if (outputChanged) parts.push(`↓x${formatRatio(outputRatio!)}`);
	return parts.join(" ");
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const promptTokens = usage.input + usage.cacheRead;
	const tier = resolveContextTier(model, "auto", promptTokens);
	const cost = getContextTierCost(model, tier);

	usage.cost.input = (cost.input / 1000000) * usage.input;
	usage.cost.output = (cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, normalizeModel(model as Model<Api>));
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 model families
 * - Opus 4.6 models (xhigh maps to adaptive effort "max" on Anthropic-compatible providers)
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.4")) {
		return true;
	}

	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		return true;
	}

	return false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
