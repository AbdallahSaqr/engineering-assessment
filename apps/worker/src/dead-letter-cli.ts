import { prisma } from "@assessment/database";
import { listDeadLetters, replayDeadLetter } from "./dead-letters.js";

/**
 * Operator entry point for exhausted notification work.
 *
 *   pnpm dead-letters list
 *   pnpm dead-letters replay <jobId>
 */
async function main() {
  const [command, argument] = process.argv.slice(2);

  if (command === "list") {
    const jobs = await listDeadLetters(prisma);

    if (jobs.length === 0) {
      console.info("No dead-lettered notification jobs.");
      return;
    }

    console.info(`${jobs.length} dead-lettered notification job(s):\n`);
    for (const job of jobs) {
      console.info(
        [
          `  id            ${job.id}`,
          `  application   ${job.applicationId}`,
          `  event         ${job.sourceEventId} (${job.type})`,
          `  attempts      ${job.attemptCount}`,
          `  last error    ${job.lastError ?? "-"}`,
          `  failed at     ${job.processedAt?.toISOString() ?? "-"}`,
          "",
        ].join("\n"),
      );
    }
    return;
  }

  if (command === "replay") {
    if (!argument) {
      throw new Error("replay requires a job id: dead-letters replay <jobId>");
    }

    await replayDeadLetter(prisma, argument);
    console.info(
      `Job ${argument} returned to the pending queue. It keeps its attempt ` +
        "count, so it has one further attempt before dead-lettering again.",
    );
    return;
  }

  throw new Error(
    "Usage:\n  dead-letters list\n  dead-letters replay <jobId>",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
