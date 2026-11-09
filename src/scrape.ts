/**
 * Drive a local Playwright (Chromium) session against x.com using a persistent
 * profile, intercept the TweetDetail GraphQL responses, and assemble a Thread.
 */
import { acquireLease } from "./lock.js";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { parseTweetDetail, parseTweetResultsByRestIds, statusIdFromUrl } from "./x-parse.js";
import type { Thread, TweetNode } from "./types.js";

export const PROFILE_DIR = path.join(os.homedir(), ".tweetmd", "profile");

export interface ScrapeOptions {
  url: string;
  headless: boolean;
  /** How many times to scroll to pull in more of the conversation. */
  scrolls?: number;
  onStatus?: (message: string) => void;
}

/**
 * Command that installs the Chromium build matching the Playwright copy this
 * module actually loads — so it works from any directory, including a global
 * `tweetmd` install, and can't pick up a different Playwright version.
 */
function browserInstallCommand(): string {
  try {
    const pkg = createRequire(import.meta.url).resolve("playwright/package.json");
    return `node "${path.join(path.dirname(pkg), "cli.js")}" install chromium`;
  } catch {
    return "npx playwright install chromium";
  }
}

async function launch(headless: boolean): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1280, height: 1800 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (err) {
    // After a Playwright upgrade the browser build it expects isn't installed yet.
    if (/Executable doesn't exist/i.test((err as Error).message)) {
      throw new Error(
        `Playwright's Chromium build isn't installed (usually after a dependency update). Run:\n  ${browserInstallCommand()}`,
      );
    }
    throw err;
  }
}

function isLoginWall(url: string): boolean {
  return /\/(login|i\/flow\/login)/.test(url);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True once the persistent profile holds an authenticated X session. */
export async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://x.com").catch(() => []);
  return cookies.some((c) => c.name === "auth_token" && !!c.value);
}

/**
 * Open a headed browser at x.com so the user can sign in once. Detects the
 * auth cookie automatically and closes the context cleanly (which is what
 * flushes cookies to disk) — and does the same on Ctrl+C, so the session is
 * saved either way.
 */
export async function login(timeoutMs = 5 * 60_000): Promise<void> {
  const context = await launch(false);

  let settling = false;
  const finish = async (message: string, code: number) => {
    if (settling) return;
    settling = true;
    try {
      await context.close(); // graceful close flushes cookies to the profile
    } catch {
      /* already closing */
    }
    console.log(message);
    process.exit(code);
  };

  // Ctrl+C must still flush the profile rather than hard-killing the browser.
  process.on("SIGINT", () => {
    void finish("\nInterrupted — saved current session state to the profile.", 0);
  });
  context.on("close", () => {
    if (!settling) {
      // User closed the window manually: nothing left to flush.
      console.log("\nBrowser closed — session state saved to the profile.");
      process.exit(0);
    }
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });
  console.log(
    "\nA browser window is open. Log in to X — this will detect when you're signed in,\n" +
      "save the session, and close automatically. (Ctrl+C also saves and exits.)\n",
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !settling) {
    if (await isLoggedIn(context)) {
      await sleep(1500); // let companion cookies (ct0, etc.) settle
      await finish("\n✓ Login detected — session saved. You can now run captures.", 0);
      return;
    }
    await sleep(2000);
  }
  await finish("\nTimed out waiting for login. Re-run `tweetmd login` and sign in.", 1);
}

/** Page loads to try before concluding X won't serve the tweet's data. */
const LOAD_ATTEMPTS = 3;

export async function scrapeThread(opts: ScrapeOptions): Promise<Thread> {
  const release = await acquireLease(path.join(os.homedir(), ".tweetmd", "capture-browser.lock"));
  try { return await scrapeUnlocked(opts); } finally { await release(); }
}

async function scrapeUnlocked(opts: ScrapeOptions): Promise<Thread> {
  const { url, headless } = opts;
  const status = opts.onStatus ?? (() => {});
  const scrolls = opts.scrolls ?? 6;

  const statusId = statusIdFromUrl(url);
  if (!statusId) throw new Error(`Could not find a status id in URL: ${url}`);

  const context = await launch(headless);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const payloads: any[] = [];
    // X Articles can embed another tweet inline (a Draft.js `TWEET` entity);
    // the article's own text/media never carry that tweet's content, so the
    // client resolves it with a side GraphQL call, which we capture the same way.
    const embedPayloads: any[] = [];

    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes("TweetDetail")) {
        try {
          payloads.push(await res.json());
        } catch {
          /* non-JSON or already consumed */
        }
      } else if (url.includes("TweetResultsByRestIds")) {
        try {
          embedPayloads.push(await res.json());
        } catch {
          /* non-JSON or already consumed */
        }
      }
    });

    // X intermittently serves the page without firing TweetDetail (a slow or
    // dropped GraphQL call), so reload a couple of times before giving up.
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
      if (attempt === 1) {
        status("Opening tweet…");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } else {
        status(`No conversation data yet — reloading (attempt ${attempt}/${LOAD_ATTEMPTS})…`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      }

      if (isLoginWall(page.url())) {
        throw new Error(
          "X is showing a login wall. Run `tweetmd login` first to sign in, then retry.",
        );
      }

      // Wait for the focal tweet (or its data) to arrive.
      await Promise.race([
        page.waitForResponse((r) => r.url().includes("TweetDetail"), { timeout: 30_000 }),
        page.waitForSelector('article[data-testid="tweet"]', { timeout: 30_000 }),
      ]).catch(() => {});

      // Scroll to pull more of the conversation; X lazy-loads replies.
      for (let i = 0; i < scrolls; i++) {
        status(`Loading conversation… (${i + 1}/${scrolls})`);
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(1200);
      }

      if (payloads.length > 0) break;
    }

    if (payloads.length === 0) {
      throw new Error(
        `No TweetDetail data was captured after ${LOAD_ATTEMPTS} attempts. The tweet may be ` +
          "protected/deleted, or the session is logged out (try `tweetmd login`).",
      );
    }

    if (process.env.TWEETMD_DUMP) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(process.env.TWEETMD_DUMP, JSON.stringify(payloads, null, 2));
      status(`Dumped ${payloads.length} raw payload(s) to ${process.env.TWEETMD_DUMP}`);
    }

    status("Parsing thread…");
    const embeddedTweets = parseTweetResultsByRestIds(embedPayloads);
    const { topLevel, replies } = parseTweetDetail(payloads, embeddedTweets);

    const mainIdx = topLevel.findIndex((t) => t.id === statusId);
    let main: TweetNode | undefined;
    let ancestors: TweetNode[] = [];
    if (mainIdx >= 0) {
      main = { ...topLevel[mainIdx], isMainTweet: true };
      ancestors = topLevel.slice(0, mainIdx);
    } else {
      // Fall back: focal tweet wasn't in the top-level list — search replies.
      const fromReplies = replies.find((t) => t.id === statusId);
      if (fromReplies) main = { ...fromReplies, isMainTweet: true };
    }

    if (!main) {
      throw new Error(
        `Captured ${topLevel.length + replies.length} tweets but none matched the requested status ${statusId}.`,
      );
    }

    const replyNodes = replies.filter((t) => t.id !== statusId);

    return {
      main,
      ancestors,
      replies: replyNodes,
      capturedAt: new Date().toISOString(),
      sourceUrl: url,
    };
  } finally {
    await context.close();
  }
}
