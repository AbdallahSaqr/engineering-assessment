import { prisma } from "@assessment/database";
import { MockEmailProvider } from "./notification-provider.js";
import { processNotificationBatch } from "./process-notifications.js";

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
const provider = new MockEmailProvider();

let stopping = false;
let running: Promise<void> | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  while (!stopping) {
    await processNotificationBatch(prisma, provider);
    if (stopping) break;
    await sleep(pollIntervalMs);
  }
}

/**
 * Stop after the current batch, not during it.
 *
 * The previous version disconnected Prisma immediately while a batch could
 * still be in flight — tearing down the connection under a write that records
 * whether a notification was delivered — and never exited, so SIGINT hung.
 */
async function shutdown() {
  if (stopping) return;
  stopping = true;

  try {
    await running;
  } catch (error) {
    console.error(error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

running = run();
running.catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
