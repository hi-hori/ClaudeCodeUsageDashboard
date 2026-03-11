// Model pricing per million tokens (USD)
interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cache_read: 1.5,
    cache_creation: 18.75,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_creation: 3.75,
  },
  "claude-haiku-4-5": {
    input: 0.8,
    output: 4,
    cache_read: 0.08,
    cache_creation: 1.0,
  },
};

// Fallback to Sonnet pricing for unknown models
const DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-6"];

function getPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

export function calculateEstimatedCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  const pricing = getPricing(model);
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cache_read +
    (cacheCreationTokens / 1_000_000) * pricing.cache_creation;
  return Math.round(cost * 10000) / 10000; // Round to 4 decimal places
}
