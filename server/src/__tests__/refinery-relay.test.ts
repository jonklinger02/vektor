import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runRefineryRelay } from "../routes/refinery-relay.js";

function fakeProc(lines: string[], exitCode = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  proc.exitCode = null;
  setTimeout(() => {
    for (const l of lines) proc.stdout.emit("data", Buffer.from(l + "\n"));
    proc.emit("close", exitCode);
  }, 0);
  return proc;
}

describe("runRefineryRelay", () => {
  it("streams text events and returns the full response", async () => {
    const chunks: string[] = [];
    const result = await runRefineryRelay({
      model: "ollama/gpt-oss:20b",
      prompt: "hello",
      env: process.env,
      onChunk: (t) => chunks.push(t),
      onStatus: () => {},
      spawnFn: (() => fakeProc([
        JSON.stringify({ type: "text", part: { text: "Refined " } }),
        JSON.stringify({ type: "text", part: { text: "plan." } }),
        "not json — ignored",
      ])) as any,
    });
    expect(chunks).toEqual(["Refined ", "plan."]);
    expect(result.fullText).toBe("Refined plan.");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr tail on nonzero exit", async () => {
    const proc = fakeProc([], 1);
    setTimeout(() => proc.stderr.emit("data", Buffer.from("model not found")), 0);
    const result = await runRefineryRelay({
      model: "m", prompt: "p", env: process.env,
      onChunk: () => {}, onStatus: () => {},
      spawnFn: (() => proc) as any,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toContain("model not found");
  });
});
