import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRefineryModels, prepareRefineryOpencodeEnv } from "../services/refinery-opencode.js";

const PROVIDERS = JSON.stringify({
  ollama: {
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama Cloud",
    options: { baseURL: "https://ollama.com/v1", apiKey: "{env:OLLAMA_API_KEY}" },
    models: { "gpt-oss:20b": { name: "GPT-OSS 20B" }, "glm-4.6": { name: "GLM 4.6" } },
  },
});

describe("prepareRefineryOpencodeEnv", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("writes a config with ALL tools denied and providers injected", async () => {
    const rt = await prepareRefineryOpencodeEnv({
      PAPERCLIP_OPENCODE_PROVIDERS: PROVIDERS,
      OLLAMA_API_KEY: "sekret",
    } as NodeJS.ProcessEnv);
    cleanup = rt.cleanup;
    const configPath = path.join(rt.env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(config.permission).toMatchObject({
      bash: "deny", edit: "deny", webfetch: "deny", external_directory: "deny",
    });
    expect(config.provider.ollama.options.apiKey).toBe("sekret"); // {env:VAR} expanded
  });

  it("cleanup removes the temp config dir", async () => {
    const rt = await prepareRefineryOpencodeEnv({} as NodeJS.ProcessEnv);
    const home = rt.env.XDG_CONFIG_HOME!;
    await rt.cleanup();
    await expect(fs.access(home)).rejects.toThrow();
  });
});

describe("listRefineryModels", () => {
  it("derives custom provider models and gates built-ins on OLLAMA_API_KEY", () => {
    const models = listRefineryModels({
      PAPERCLIP_OPENCODE_PROVIDERS: PROVIDERS,
      OLLAMA_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("ollama/gpt-oss:20b");
    expect(ids).toContain("ollama-cloud/deepseek-v3.1:671b"); // built-in
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it("returns [] custom and [] built-ins when nothing is configured", () => {
    expect(listRefineryModels({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("tolerates invalid providers JSON (the 2026-07-06 truncation regression)", () => {
    const models = listRefineryModels({
      PAPERCLIP_OPENCODE_PROVIDERS: "{truncated",
      OLLAMA_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(models.some((m) => m.id.startsWith("ollama-cloud/"))).toBe(true); // built-ins survive
  });
});
