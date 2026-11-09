/** One bounded provider check shared by enrichment and classification for a run. */
import { spawn } from "node:child_process";
import os from "node:os";

export interface ProviderStatus {
  /** True only when the CLI can currently perform requests. */
  available: boolean;
  authenticated: boolean;
  error?: string;
}

function run(bin: string, args: string[], input = "", timeoutMs = 30_000): Promise<{ code: number | null; text: string; missing?: boolean; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    let settled = false;
    const finish = (result: { code: number | null; text: string; missing?: boolean; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Never return raw provider stderr: it can contain account/config details.
    proc.stdout.on("data", (chunk) => { text = (text + chunk.toString()).slice(0, 64_000); });
    proc.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish({ code: null, text: "", timedOut: true });
    }, timeoutMs);
    proc.on("error", () => finish({ code: null, text: "", missing: true }));
    proc.on("close", (code) => finish({ code, text }));
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}

/** No shared global cache: callers share the result within their capture/batch. */
export async function preflightClaude(bin = "claude"): Promise<ProviderStatus> {
  const auth = await run(bin, ["auth", "status", "--json"], "", 10_000);
  if (auth.missing) return { available: false, authenticated: false, error: "Claude CLI is unavailable." };
  if (auth.timedOut) return { available: false, authenticated: false, error: "Claude authentication check timed out." };
  try {
    const status = JSON.parse(auth.text);
    if (status.loggedIn === false) return { available: false, authenticated: false, error: "Claude CLI is signed out. Run `claude auth login` before retrying optional AI stages." };
  } catch { /* Older CLIs may not support auth status. The request probe below is authoritative. */ }
  const probe = await run(bin, ["-p", "--strict-mcp-config", "--output-format", "json", "--max-turns", "1"], "Reply with OK only.");
  let body: { is_error?: boolean; result?: string } | undefined;
  try { body = JSON.parse(probe.text); } catch { /* Invalid response is not a passing preflight. */ }
  if (probe.code !== 0 || probe.timedOut || body?.is_error || typeof body?.result !== "string" || !body.result.trim()) {
    return { available: false, authenticated: false, error: probe.timedOut ? "Claude request preflight timed out." : "Claude request preflight failed. Check CLI authentication and provider access before retrying optional AI stages." };
  }
  return { available: true, authenticated: true };
}
