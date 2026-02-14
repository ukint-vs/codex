import { spawn, type ChildProcess } from "node:child_process";

const childEnv = { ...process.env };
const DEMO_UI_BASE_URL = (
  process.env.DEMO_UI_BASE_URL ?? "http://127.0.0.1:4180"
).replace(/\/+$/, "");
const REUSE_UI = process.env.DEMO_LIVE_REUSE_UI === "1";

const spawnPnpmScript = (script: string): ChildProcess =>
  spawn("pnpm", ["run", script], {
    stdio: "inherit",
    env: childEnv,
    shell: false,
  });

const stopChild = (cp: ChildProcess | null | undefined) => {
  if (!cp || cp.killed) return;
  try {
    cp.kill("SIGTERM");
  } catch {
    // ignore
  }
};

const isDemoUiRunning = async (): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${DEMO_UI_BASE_URL}/api/snapshot`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

async function main() {
  console.log("Starting demo UI + auto trader...");
  console.log(`Chart URL: ${DEMO_UI_BASE_URL}\n`);

  let ui: ChildProcess | null = null;
  const running = await isDemoUiRunning();
  if (running) {
    if (!REUSE_UI) {
      console.error(
        [
          "Demo UI is already running.",
          "Stop it first so the latest code is used, then run `pnpm demo:live` again.",
          "Or run with DEMO_LIVE_REUSE_UI=1 to keep the existing server.",
        ].join(" "),
      );
      process.exit(1);
    }
    console.log("Demo UI already running, reusing existing server.");
  } else {
    ui = spawnPnpmScript("demo:ui");
    // Give the server a short head start before the trader begins.
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }

  const trader = spawnPnpmScript("demo:auto-trader");

  const shutdown = () => {
    stopChild(trader);
    stopChild(ui);
  };

  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });

  ui?.on("exit", (code) => {
    stopChild(trader);
    process.exit(code ?? 0);
  });

  trader.on("exit", (code) => {
    if (code && code !== 0) {
      stopChild(ui);
      process.exit(code);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
