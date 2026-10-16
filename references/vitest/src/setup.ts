import { aroundEach } from "vitest";

aroundEach(async (runTest, context) => {
  const metadata = context.task.meta as Record<string, unknown>;
  const previous = metadata.dockVitestAttemptCount;
  metadata.dockVitestAttemptCount =
    typeof previous === "number" && Number.isSafeInteger(previous)
      ? previous + 1
      : 1;
  await runTest();
});
