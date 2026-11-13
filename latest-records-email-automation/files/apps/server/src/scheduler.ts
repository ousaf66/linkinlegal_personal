import "dotenv/config";

import { randomUUID } from "node:crypto";

import type { ScheduledTask } from "node-cron";

import { dbConnection } from "./config/db-config";
import redis from "./lib/redis";
import { initBillingWebhookBackstopCronJobs } from "./modules/billing/webhooks/stripe-backstop.cron";
import { initCompanyComplianceReminderCronJobs } from "./modules/companies/compliance/services/reminders.cron";
import { initDocumentExpiryReminderCronJobs } from "./modules/companies/register/register-reminders.cron";
import { initComplianceMonitoringCronJobs } from "./modules/compliance-monitoring/monitoring.cron";
import { initTrackedThreadsCronJobs } from "./modules/ms-addin/tracked-threads/tracked-threads.cron";
import { initDocumentProcessingCronJobs } from "./modules/documents/documents.cron";
import { initFirmAddOnRenewalCronJobs } from "./modules/billing/quotes/firm/firm-add-on-renewal.cron";
import { initUserDataPurgeCronJobs } from "./modules/users/data-purge/user-data-purge.cron";
import { initNurtureCronJobs } from "./modules/users/nurture/nurture.cron";
import { initMeetingReminderCronJobs } from "./modules/meetings/meeting-reminders.cron";
import { initMeetingBotCronJobs } from "./modules/meetings/bot/meeting-bot.cron";
import { initOutreachCronJobs } from "./modules/outreach/outreach.cron";
import { initPushReceiptCronJobs } from "./modules/push/push-receipts.cron";
import { initSearchNamesCronJobs } from "./modules/public-api/sanctions/search-names.cron";
import { initSanctionDigestCronJobs } from "./modules/sanction-pep/digest/sanction-digest.cron";
import { initSanctionListingsCronJobs } from "./modules/sanction-pep/sanction-listings.cron";
import { initLatestRecordsAlertCronJobs } from "./modules/sanction-pep/latest-records/latest-records-alert.cron";
import { initSignatureCronJobs } from "./modules/signatures/signatures.cron";
import { initComplianceCronJobs } from "./modules/compliance/compliance.cron";
import {
  createCronJobRunner,
  type CronLeaseCollection,
  type CronLeaseDocument,
  type CronJobRunner,
  type CronJobRunnerController,
} from "./utils/cron-lease";
import { initSubscriptionCronJobs } from "./utils/cronjob";
import { closeDependencies, withTimeout } from "./utils/graceful-shutdown";
import { systemLogger } from "./utils/logger";
import { startMetricsExporter } from "./utils/metrics";
import { startProcessHeartbeat, type ProcessHeartbeatHandle } from "./utils/process-heartbeat";

const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 10_000;

async function stopCronTasks(tasks: Array<ScheduledTask>) {
  await Promise.allSettled(tasks.map((task) => task.stop()));
}

function createShutdown(
  tasks: Array<ScheduledTask>,
  runner: CronJobRunnerController,
  heartbeat: ProcessHeartbeatHandle,
  metrics: { stop: () => void },
) {
  let shutdownPromise: Promise<void> | undefined;

  return (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    systemLogger.info({ signal }, "Scheduler shutdown started");
    shutdownPromise = (async () => {
      heartbeat.stop();
      metrics.stop();
      await stopCronTasks(tasks);

      let drainError: unknown;
      try {
        await withTimeout(
          runner.waitForIdle(),
          DRAIN_TIMEOUT_MS,
          `Scheduler drain exceeded ${DRAIN_TIMEOUT_MS}ms`,
        );
      } catch (error) {
        drainError = error;
        systemLogger.warn({ error }, "Scheduler drain timed out; aborting active jobs");
        runner.abortActiveJobs(error);
        await withTimeout(
          runner.releaseActiveLeases(),
          CLEANUP_TIMEOUT_MS,
          `Scheduler lease cleanup exceeded ${CLEANUP_TIMEOUT_MS}ms`,
        );
      }

      await closeDependencies();
      if (drainError) throw drainError;
    })().catch((error) => {
      redis.disconnect();
      throw error;
    });
    return shutdownPromise;
  };
}

async function main() {
  systemLogger.info("Starting scheduler...");
  const metrics = startMetricsExporter((error) => {
    systemLogger.error({ error }, "Failed to export scheduler metrics");
  });
  const tasks: Array<ScheduledTask> = [];
  let runner: CronJobRunnerController | undefined;

  try {
    const [connection] = await Promise.all([dbConnection(), redis.ping()]);
    const leases = connection.connection.db!.collection<CronLeaseDocument>("cron_job_leases");
    await leases.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Local testing: SCHEDULER_JOBS=tracked-threads-sync runs only the named jobs, once at start
    // and then on schedule, with no dedup window so a restart runs them again.
    const onlyJobs = process.env.SCHEDULER_JOBS?.split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    runner = createCronJobRunner(leases as unknown as CronLeaseCollection, randomUUID());

    const leasedRun = runner.run;
    let run: CronJobRunner;

    if (onlyJobs?.length) {
      run = (jobName, task, options) => {
        if (onlyJobs.includes(jobName)) {
          return leasedRun(jobName, task, { ...options, dedupMs: 0 });
        } else {
          return Promise.resolve();
        }
      };
    } else {
      run = leasedRun;
    }

    tasks.push(...initSubscriptionCronJobs(run));
    tasks.push(...initSignatureCronJobs(run));
    tasks.push(...initComplianceCronJobs(run));
    tasks.push(...initCompanyComplianceReminderCronJobs(run));
    tasks.push(...initDocumentExpiryReminderCronJobs(run));
    tasks.push(...initComplianceMonitoringCronJobs(run));
    tasks.push(...initDocumentProcessingCronJobs(run));
    tasks.push(...initTrackedThreadsCronJobs(run));
    tasks.push(...initUserDataPurgeCronJobs(run));
    tasks.push(...initNurtureCronJobs(run));
    tasks.push(...initFirmAddOnRenewalCronJobs(run));
    tasks.push(...initBillingWebhookBackstopCronJobs(run));
    tasks.push(...initMeetingReminderCronJobs(run));
    tasks.push(...initMeetingBotCronJobs(run));
    tasks.push(...initSanctionDigestCronJobs(run));
    tasks.push(...initSearchNamesCronJobs(run));
    tasks.push(...initSanctionListingsCronJobs(run));
    tasks.push(...initLatestRecordsAlertCronJobs(run));
    tasks.push(...initOutreachCronJobs(run));
    tasks.push(...initPushReceiptCronJobs(run));
    systemLogger.info({ taskCount: tasks.length, onlyJobs }, "Scheduler started");
    if (onlyJobs?.length) {
      for (const task of tasks) {
        task.execute().catch((error: unknown) => {
          systemLogger.error({ error }, "Scheduler start-up run failed");
        });
      }
    }
  } catch (error) {
    metrics.stop();
    await stopCronTasks(tasks);
    await closeDependencies().catch(() => undefined);
    throw error;
  }

  const heartbeat = startProcessHeartbeat(process.env.SERVICE_NAME ?? "scheduler", {
    onError: (error) => {
      systemLogger.error({ error }, "Failed to update scheduler process heartbeat");
    },
  });
  const shutdown = createShutdown(tasks, runner, heartbeat, metrics);
  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal)
      .then(() => {
        systemLogger.info({ signal }, "Scheduler shutdown completed");
        process.exit(0);
      })
      .catch((error) => {
        systemLogger.error({ error, signal }, "Scheduler shutdown failed");
        process.exit(1);
      });
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

main().catch((error) => {
  systemLogger.fatal({ error }, "Scheduler startup failed");
  process.exit(1);
});
