import { prisma } from "@assessment/database";
import { MockEmailProvider } from "./notification-provider.js";
import { processNotificationBatch } from "./process-notifications.js";

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
const provider = new MockEmailProvider();
let stopping = false;

async function run() {
  while (!stopping) {
    await processNotificationBatch(prisma, provider);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function shutdown() {
  stopping = true;
  await prisma.$disconnect();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
