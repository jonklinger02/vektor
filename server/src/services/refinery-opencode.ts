import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RefineryModelOption } from "@paperclipai/shared";

/**
 * Refinery relay runtime config. SECURITY INVARIANT: the spawned opencode is
 * a pure inference relay — every tool permission is denied. Do not "fix" this
 * by allowing bash/webfetch; the server runs as root on an authenticated
 * deployment and prompt injection would reach any allowed tool.
 */
const DENY_ALL_PERMISSION = {
  bash: "deny",
  edit: "deny",
  webfetch: "deny",
  external_directory: "deny",
} as const;

/** Built-in opencode provider models, available whenever the key is present. */
const OLLAMA_CLOUD_BUILTINS: RefineryModelOption[] = [
  { id: "ollama-cloud/gpt-oss:20b", label: "GPT-OSS 20B (Ollama Cloud)", tier: "cheap" },
  { id: "ollama-cloud/gpt-oss:120b", label: "GPT-OSS 120B (Ollama Cloud)", tier: "standard" },
  { id: "ollama-cloud/qwen3-coder:480b", label: "Qwen3 Coder 480B (Ollama Cloud)", tier: "standard" },
  { id: "ollama-cloud/deepseek-v3.1:671b", label: "DeepSeek V3.1 671B (Ollama Cloud)", tier: "frontier" },
  { id: "ollama-cloud/glm-4.6", label: "GLM 4.6 (Ollama Cloud)", tier: "standard" },
];

function expandEnvPlaceholders(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => expandEnvPlaceholders(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvPlaceholders(v, env)]),
    );
  }
  return value;
}

function parseProviders(env: NodeJS.ProcessEnv, notes: string[]): Record<string, unknown> | null {
  const raw = env.PAPERCLIP_OPENCODE_PROVIDERS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return expandEnvPlaceholders(parsed, env) as Record<string, unknown>;
  } catch {
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
}

const REFINERY_MODEL_TIERS = new Set(["cheap", "standard", "frontier"]);

/**
 * Extra models surfaced in the Refinery picker beyond the auto-detected
 * providers — e.g. `anthropic/*` models served through opencode's own auth
 * (a Claude Pro/Max subscription logged in via `opencode auth login`, which
 * the relay inherits because it doesn't override XDG_DATA_HOME). Env-driven
 * rather than hardcoded so model ids track opencode's catalog without a code
 * change. Shape: JSON array of {id, label?, tier?}; malformed entries skipped.
 */
function parseExtraModels(env: NodeJS.ProcessEnv, notes: string[]): RefineryModelOption[] {
  const raw = env.PAPERCLIP_REFINERY_EXTRA_MODELS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notes.push("PAPERCLIP_REFINERY_EXTRA_MODELS contains invalid JSON; extra models ignored.");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RefineryModelOption[] = [];
  for (const entry of parsed) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id) continue;
    const label = (entry as { label?: unknown })?.label;
    const tier = (entry as { tier?: unknown })?.tier;
    out.push({
      id,
      label: typeof label === "string" && label ? label : id,
      tier: typeof tier === "string" && REFINERY_MODEL_TIERS.has(tier)
        ? (tier as RefineryModelOption["tier"])
        : "standard",
    });
  }
  return out;
}

export interface RefineryRuntime {
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
  notes: string[];
}

export async function prepareRefineryOpencodeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<RefineryRuntime> {
  const notes: string[] = [];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-refinery-opencode-"));
  const dir = path.join(home, "opencode");
  await fs.mkdir(dir, { recursive: true });
  const config: Record<string, unknown> = { permission: { ...DENY_ALL_PERMISSION } };
  const providers = parseProviders(baseEnv, notes);
  if (providers) config.provider = providers;
  await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify(config, null, 2));
  return {
    env: { ...baseEnv, XDG_CONFIG_HOME: home },
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
    notes,
  };
}

export function listRefineryModels(env: NodeJS.ProcessEnv = process.env): RefineryModelOption[] {
  const out: RefineryModelOption[] = [];
  const providers = parseProviders(env, []);
  if (providers) {
    for (const [providerKey, providerVal] of Object.entries(providers)) {
      const models = (providerVal as { models?: Record<string, { name?: string }> }).models ?? {};
      const providerName = (providerVal as { name?: string }).name ?? providerKey;
      for (const [modelKey, modelVal] of Object.entries(models)) {
        out.push({
          id: `${providerKey}/${modelKey}`,
          label: `${modelVal?.name ?? modelKey} (${providerName})`,
          tier: "cheap",
        });
      }
    }
  }
  if (env.OLLAMA_API_KEY) {
    for (const m of OLLAMA_CLOUD_BUILTINS) {
      if (!out.some((o) => o.id === m.id)) out.push(m);
    }
  }
  for (const m of parseExtraModels(env, [])) {
    if (!out.some((o) => o.id === m.id)) out.push(m);
  }
  return out;
}
