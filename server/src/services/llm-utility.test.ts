import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));

import { readConfigFile } from "../config-file.js";
import { completeText } from "./llm-utility.js";

const PROVIDER_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_API_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.mocked(readConfigFile).mockReturnValue(null);
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

function stubFetchOnce(payload: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("completeText provider resolution", () => {
  it("returns null with no provider configured", async () => {
    await expect(completeText({ prompt: "hi" })).resolves.toBeNull();
  });

  it("routes to Ollama Cloud on OLLAMA_API_KEY with Bearer auth and the cloud base URL", async () => {
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = stubFetchOnce({
      choices: [{ message: { content: "pong" } }],
    });

    await expect(completeText({ prompt: "ping" })).resolves.toBe("pong");

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://ollama.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-ollama-key",
    );
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("gpt-oss:20b");
  });

  it("anthropic key outranks ollama", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    process.env.OLLAMA_API_KEY = "ollama-key";
    const fetchMock = stubFetchOnce({ content: [{ type: "text", text: "claude says" }] });

    await expect(completeText({ prompt: "ping" })).resolves.toBe("claude says");
    const [url] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(url).toContain("api.anthropic.com");
  });

  it("config-file llm block with provider ollama + custom baseUrl runs keyless (self-hosted daemon)", async () => {
    vi.mocked(readConfigFile).mockReturnValue({
      llm: { provider: "ollama", baseUrl: "http://192.168.2.44:11434/v1", model: "hermes3" },
    } as ReturnType<typeof readConfigFile>);
    const fetchMock = stubFetchOnce({ choices: [{ message: { content: "local pong" } }] });

    await expect(completeText({ prompt: "ping" })).resolves.toBe("local pong");
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://192.168.2.44:11434/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("hermes3");
  });

  it("never throws: HTTP failure resolves to null", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    stubFetchOnce({}, false);
    await expect(completeText({ prompt: "ping" })).resolves.toBeNull();
  });

  it("never throws: network error resolves to null", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(completeText({ prompt: "ping" })).resolves.toBeNull();
  });
});
