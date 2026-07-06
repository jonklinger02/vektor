import { spawn } from "node:child_process";

const RELAY_TIMEOUT_MS = 120_000;
const STDERR_TAIL_MAX = 2_000;

export interface RelayOptions {
  model: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  onChunk(text: string): void;
  onStatus(text: string): void;
  spawnFn?: typeof spawn;
  signal?: AbortSignal;
}

/**
 * Spawn `opencode run` as a pure inference relay (tools denied via the
 * XDG config in opts.env — see refinery-opencode.ts) and stream text events.
 *
 * opencode JSONL event shape (confirmed against
 * packages/adapters/opencode-local/src/server/parse.ts):
 *   { type: "text", part: { text } }              — streamed text chunk
 *   { type: "step_finish", part: { tokens, cost } } — usage/cost, end of a step
 *   { type: "tool_use", part: { state } }           — tool call (denied here; ignored)
 *   { type: "error", error | message }              — error payload (string or object)
 */
export function runRefineryRelay(opts: RelayOptions): Promise<{
  fullText: string;
  exitCode: number;
  stderrTail: string;
}> {
  return new Promise((resolve) => {
    const spawnFn = opts.spawnFn ?? spawn;
    const proc = spawnFn("opencode", ["run", "--format", "json", "--model", opts.model], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp",
      env: opts.env,
    });

    if (opts.signal) {
      if (opts.signal.aborted) proc.kill("SIGTERM");
      else opts.signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
    }

    let fullText = "";
    let stderrTail = "";
    let settled = false;

    const timeout = setTimeout(() => proc.kill("SIGTERM"), RELAY_TIMEOUT_MS);

    let stdoutBuf = "";
    proc.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "text" && event.part?.text) {
          fullText += event.part.text;
          opts.onChunk(event.part.text);
        } else if (event.type === "step_start" || event.type === "step_finish") {
          opts.onStatus("Thinking...");
        } else if (event.type === "error") {
          const detail = event.error ?? event.message ?? event;
          const text = typeof detail === "string" ? detail : JSON.stringify(detail);
          stderrTail = (stderrTail + `\n${text}`).slice(-STDERR_TAIL_MAX);
        }
      }
    });

    proc.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_MAX);
    });

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ fullText, exitCode, stderrTail: stderrTail.trim() });
    };
    // Defer settlement one tick past `close`/`error`: a real child process
    // only emits `close` once its stdio streams have ended, but flushes can
    // still be mid-flight in test doubles (and, in principle, under real
    // event-loop scheduling) — the setImmediate hop lets any stderr/stdout
    // `data` events already queued for this turn land before we resolve.
    proc.on("close", (code: number | null) => setImmediate(() => settle(code ?? 0)));
    proc.on("error", (err: unknown) => {
      stderrTail = (stderrTail + String(err)).slice(-STDERR_TAIL_MAX);
      setImmediate(() => settle(127));
    });

    proc.stdin.write(opts.prompt);
    proc.stdin.end();
  });
}
