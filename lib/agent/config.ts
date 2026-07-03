import { getSettingByKey } from '@/lib/repositories/settingsRepository';

/**
 * Resolution of which model/key the in-app agent uses.
 *
 * For self-hosters (BYOK), the Anthropic API key comes from the environment or
 * an optional settings override; the model is configurable with a sensible
 * default. The Ycode Cloud overlay supplies its own hosted resolution.
 */

/** Default Anthropic model. Overridable via ANTHROPIC_MODEL or the settings store. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

/** Max tokens per assistant turn. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Hard ceiling on tool-calling round trips per user message, to bound runaway loops. */
export const MAX_TOOL_TURNS = 24;

/**
 * Cross-turn conversation history budget, applied before the agent runs so a long
 * chat can't blow past the model's context window (the failure where the agent
 * silently stops editing on big histories). The oldest turns are dropped first.
 * `MAX_HISTORY_CHARS` is a rough proxy for tokens (~chars/4) and leaves headroom
 * for the system prompt, tool schemas, the injected page snapshot, and the
 * in-turn tool-loop growth.
 */
export const MAX_HISTORY_MESSAGES = 24;
export const MAX_HISTORY_CHARS = 160_000;

const SETTING_API_KEY = 'ai_anthropic_api_key';
const SETTING_MODEL = 'ai_model';

export interface ResolvedAgentConfig {
  apiKey: string | null;
  model: string;
}

/**
 * Resolve the BYOK Anthropic configuration.
 *
 * Key precedence: settings override, then ANTHROPIC_API_KEY env var.
 * Model precedence: settings override, then ANTHROPIC_MODEL env var, then default.
 */
export async function resolveAgentConfig(): Promise<ResolvedAgentConfig> {
  const [settingKey, settingModel] = await Promise.all([
    getSettingByKey(SETTING_API_KEY).catch(() => null),
    getSettingByKey(SETTING_MODEL).catch(() => null),
  ]);

  const apiKey = asNonEmptyString(settingKey)
    ?? asNonEmptyString(process.env.ANTHROPIC_API_KEY)
    ?? null;

  const model = asNonEmptyString(settingModel)
    ?? asNonEmptyString(process.env.ANTHROPIC_MODEL)
    ?? DEFAULT_ANTHROPIC_MODEL;

  return { apiKey, model };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
