import Cron, { type ScheduledTask } from "node-cron";

import type { CronJobRunner } from "@/utils/cron-lease";
import { createLogger } from "@/utils/logger";

import { runLatestRecordsAlert } from "./latest-records-alert.service";

const logger = createLogger("sanction-latest-records-cron");

export function initLatestRecordsAlertCronJobs(runJob: CronJobRunner): ScheduledTask[] {
  // Every 15 minutes, which includes 15:00 sharp. Before 15:00, and once the
  // day's email has gone, a check reads one state document. Between 15:00 and
  // the send it also reads the newest record's _id, to hold the email while a
  // late load is still arriving. An email missed while the scheduler was down
  // goes at the first check after it is back.
  const task = Cron.schedule(
    "*/15 * * * *",
    async () =>
      runJob("sanction-latest-records-alert", async (signal) => {
        try {
          const result = await runLatestRecordsAlert(new Date(), signal);
          if (result.action === "daily") {
            logger.info(result, "Sent the daily Sanction Search records email");
          } else if (result.action === "wait") {
            logger.info("Records are still arriving; the daily email waits for the load to finish");
          }
        } catch (error) {
          logger.error({ error }, "Error in the daily Sanction Search records email");
          throw error;
        }
      }),
    { noOverlap: true },
  );

  return [task];
}
