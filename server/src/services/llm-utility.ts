import { readConfigFile } from "../config-file.js";

// Minimal platform-side text-completion helper for internal utility calls
// (e.g. the agent self-learning review). The fork has no internal LLM client,
// so this goes straight to the provider HTTP APIs with plain fetch.
//
// Provider resolution (first configured key wins):
//   1. Anthropic — env ANTHROPIC_API_KEY, or config-file llm block with
//      provider "claude" and an apiKey.
//   2. OpenAI — env OPENAI_API_KEY, or config-file llm block with provider
//      "openai" and an apiKey.
//   3. Ollama Cloud — env OLLAMA_API_KEY, or config-file llm block with
//      provider "ollama" (OpenAI-compatible /v1; llm.baseUrl overrides for a
//      self-hosted daemon, which may be keyless).
//   4. None → null (the calling feature is silently disabled).
//
// completeText NEVER throws — any failure (no key, HTTP error, timeout,
// malformed payload) resolves to null.

const COMPLETION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-5-mini";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
const OLLAMA_MODEL = "gpt-oss:20b";

export interface CompleteTextInput {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

type ResolvedProvider =
  | { provider: "anthropic"; apiKey: string }
  | { provider: "openai"; apiKey: string }
  | { provider: "ollama"; apiKey: string; baseUrl: string; model: string }
  | null;

function resolveProvider(): ResolvedProvider {
  const config = readConfigFile();
  const configProvider = config?.llm?.provider ?? null;
  const configKey = config?.llm?.apiKey?.trim() || null;

  const anthropicKey =
    process.env.ANTHROPIC_API_KEY?.trim() ||
    (configProvider === "claude" ? configKey : null);
  if (anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };

  const openaiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    (configProvider === "openai" ? configKey : null);
  if (openaiKey) return { provider: "openai", apiKey: openaiKey };

  const ollamaKey =
    process.env.OLLAMA_API_KEY?.trim() ||
    (configProvider === "ollama" ? configKey : null);
  const ollamaBaseUrl =
    (configProvider === "ollama" ? config?.llm?.baseUrl?.trim() : null) ||
    OLLAMA_CLOUD_BASE_URL;
  // A self-hosted daemon (non-cloud baseUrl) may be keyless; Ollama Cloud needs a key.
  if (ollamaKey || (configProvider === "ollama" && ollamaBaseUrl !== OLLAMA_CLOUD_BASE_URL)) {
    return {
      provider: "ollama",
      apiKey: ollamaKey ?? "",
      baseUrl: ollamaBaseUrl,
      model: (configProvider === "ollama" ? config?.llm?.model?.trim() : null) || OLLAMA_MODEL,
    };
  }

  return null;
}

async function completeViaAnthropic(
  apiKey: string,
  input: CompleteTextInput,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(ANTHROPIC_MESSAGES_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: input.prompt }],
    }),
    signal,
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { content?: unknown };
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.length > 0) {
      return rec.text;
    }
  }
  return null;
}

async function completeViaOpenAi(
  apiKey: string,
  input: CompleteTextInput,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(OPENAI_CHAT_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        ...(input.system ? [{ role: "system", content: input.system }] : []),
        { role: "user", content: input.prompt },
      ],
    }),
    signal,
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

async function completeViaOllama(
  resolved: { apiKey: string; baseUrl: string; model: string },
  input: CompleteTextInput,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(
    `${resolved.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        // Keyless self-hosted daemons reject no header; only send auth when a key exists.
        ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          ...(input.system ? [{ role: "system", content: input.system }] : []),
          { role: "user", content: input.prompt },
        ],
      }),
      signal,
    },
  );
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

/**
 * Run a one-shot text completion on whichever provider is configured.
 * Returns the completion text, or null when no provider is configured or
 * anything at all goes wrong. Never throws.
 */
export async function completeText(input: CompleteTextInput): Promise<string | null> {
  try {
    const resolved = resolveProvider();
    if (!resolved) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
    try {
      if (resolved.provider === "anthropic") {
        return await completeViaAnthropic(resolved.apiKey, input, controller.signal);
      }
      if (resolved.provider === "ollama") {
        return await completeViaOllama(resolved, input, controller.signal);
      }
      return await completeViaOpenAi(resolved.apiKey, input, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}
