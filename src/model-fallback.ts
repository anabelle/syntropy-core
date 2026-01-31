/**
 * Model Fallback Configuration
 * 
 * Provides resilience against rate limits by rotating between free tier models.
 * Each model has different rate limits - by using multiple, we can continue
 * operating even when one provider is exhausted.
 * 
 * Updated: 2026-01-28
 */

export interface ModelConfig {
    name: string;
    provider: 'openrouter';
    dailyLimit?: number;  // Approximate requests per day
    notes?: string;
}

// Free models available on OpenRouter (updated 2026-01-31)
// Order matters - we try from top to bottom
export const FREE_MODELS: ModelConfig[] = [
    {
        name: 'tngtech/deepseek-r1t2-chimera:free',
        provider: 'openrouter',
        dailyLimit: 200,
        notes: 'Primary - DeepSeek R1+V3 merger, good for tool-calling (verified working)'
    },
    {
        name: 'meta-llama/llama-3.3-70b-instruct:free',
        provider: 'openrouter',
        dailyLimit: 200,
        notes: 'Fallback - excellent instruction following'
    },
    {
        name: 'deepseek/deepseek-r1-0528:free',
        provider: 'openrouter',
        dailyLimit: 50,
        notes: 'Fallback - strong reasoning (o1-level)'
    },
    {
        name: 'qwen/qwen3-235b-a22b:free',
        provider: 'openrouter',
        dailyLimit: 200,
        notes: 'Fallback - large Qwen model'
    },
    {
        name: 'microsoft/phi-4:free',
        provider: 'openrouter',
        dailyLimit: 200,
        notes: 'Fallback - Microsoft small but capable'
    }
];

// Track which models have hit rate limits (resets daily at midnight UTC)
interface RateLimitState {
    exhaustedModels: Set<string>;
    lastReset: string;  // ISO date string (YYYY-MM-DD)
}

let rateLimitState: RateLimitState = {
    exhaustedModels: new Set(),
    lastReset: new Date().toISOString().split('T')[0]
};

/**
 * Check if it's a new day and reset exhausted models
 */
function maybeResetRateLimits(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== rateLimitState.lastReset) {
        console.log('[MODEL-FALLBACK] New day detected, resetting rate limit tracking');
        rateLimitState = {
            exhaustedModels: new Set(),
            lastReset: today
        };
    }
}

/**
 * Mark a model as exhausted for today
 */
export function markModelExhausted(modelName: string): void {
    maybeResetRateLimits();
    rateLimitState.exhaustedModels.add(modelName);
    console.log(`[MODEL-FALLBACK] Marked ${modelName} as exhausted. Available models: ${getAvailableModels().length}`);
}

/**
 * Get list of models that haven't hit rate limits today
 */
export function getAvailableModels(): ModelConfig[] {
    maybeResetRateLimits();
    return FREE_MODELS.filter(m => !rateLimitState.exhaustedModels.has(m.name));
}

/**
 * Get the next available model to use
 * Returns the first non-exhausted model, or the primary model if all exhausted
 */
export function getNextAvailableModel(): ModelConfig {
    const available = getAvailableModels();
    if (available.length > 0) {
        return available[0];
    }
    // All exhausted - return primary anyway (let it fail with clear error)
    console.warn('[MODEL-FALLBACK] All free models exhausted! Returning primary model.');
    return FREE_MODELS[0];
}

/**
 * Check if an error is a rate limit error
 */
export function isRateLimitError(error: any): boolean {
    if (!error) return false;
    const message = error.message || String(error);
    const cause = error.cause?.message || '';
    const responseBody = error.responseBody || '';
    const fullError = `${message} ${cause} ${responseBody}`;

    return (
        fullError.includes('Rate limit') ||
        fullError.includes('rate-limited') ||
        fullError.includes('429') ||
        fullError.includes('rate_limit') ||
        fullError.includes('free-models-per-day') ||
        fullError.includes('temporarily rate-limited upstream')
    );
}

/**
 * Handle a rate limit error - mark model as exhausted and suggest fallback
 */
export function handleRateLimitError(currentModel: string, error: any): ModelConfig | null {
    console.log(`[MODEL-FALLBACK] Rate limit hit on ${currentModel}`);
    markModelExhausted(currentModel);

    const available = getAvailableModels();
    if (available.length > 0) {
        console.log(`[MODEL-FALLBACK] Switching to fallback: ${available[0].name}`);
        return available[0];
    }

    console.warn('[MODEL-FALLBACK] No fallback models available!');
    return null;
}
