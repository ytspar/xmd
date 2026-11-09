/** Cross-process lease. Only an owner or a demonstrably dead process is removed. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function acquireLease(file: string, timeoutMs = 120_000): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await fs.open(file, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
      return async () => {
        const owner = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
        if (owner?.token === token) await fs.unlink(file).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            // Recheck ownership before removing an abandoned lease.
            const latest = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
            if (latest?.token === owner.token) await fs.unlink(file).catch(() => {});
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for active lease: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
