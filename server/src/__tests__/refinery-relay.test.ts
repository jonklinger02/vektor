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

/** Like fakeProc, but does NOT auto-schedule `close` — the test drives it. */
function controllableProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  proc.exitCode = null;
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

  it("kills the spawned process with SIGTERM on abort — mid-run and already-aborted", async () => {
    // (a) abort AFTER spawn
    const proc = controllableProc();
    const controller = new AbortController();
    const resultPromise = runRefineryRelay({
      model: "m",
      prompt: "p",
      env: process.env,
      onChunk: () => {},
      onStatus: () => {},
      spawnFn: (() => proc) as any,
      signal: controller.signal,
    });

    controller.abort();

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    proc.emit("close", 0);
    await resultPromise;

    // (b) signal already aborted BEFORE spawn
    const proc2 = controllableProc();
    const controller2 = new AbortController();
    controller2.abort();

    const resultPromise2 = runRefineryRelay({
      model: "m",
      prompt: "p",
      env: process.env,
      onChunk: () => {},
      onStatus: () => {},
      spawnFn: (() => proc2) as any,
      signal: controller2.signal,
    });

    expect(proc2.kill).toHaveBeenCalledTimes(1);
    expect(proc2.kill).toHaveBeenCalledWith("SIGTERM");

    proc2.emit("close", 0);
    await resultPromise2;
  });
});
