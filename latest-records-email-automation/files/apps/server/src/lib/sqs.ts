import { randomUUID } from "node:crypto";

import { GoogleDriveSyncFile, GoogleDriveSyncFolder } from "@/modules/sync/lib/google/types";
import type { ComplianceQueuePayload } from "@/modules/compliance/compliance.types";
import type { CompanyComplianceQueuePayload } from "@/modules/companies/compliance/compliance.types";
import type { ContractDraftingQueuePayload } from "@/modules/contract-drafting/contract-drafting.types";
import type { PdfTranslationQueuePayload } from "@/modules/pdf-translations/pdf-translations.types";
import {
  MessageAttributeValue,
  SQSClient,
  SendMessageBatchCommand,
  type SendMessageBatchCommandOutput,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createLogger } from "../utils/logger";
import type { SyncJobPayload } from "@/modules/sync/jobs/sync.payload";
import { sendEmailViaSmtp } from "./email-smtp";
import { uploadFile } from "./storage";
import { env } from "./env";
import { INTERNAL_QUEUES, type InternalQueue } from "./queues/config";
import { enqueueBullMq, enqueueBullMqBatch, getInternalSqsQueueUrl } from "./queues/internal";

const sqsLogger = createLogger("sqs");

const sqsClient = new SQSClient({
  credentials: {
    accessKeyId: env.SQS_ACCESS_KEY,
    secretAccessKey: env.SQS_SECRET_KEY,
  },
  region: env.SQS_REGION,
});

type EnqueueParams = {
  queueUrl: string;
  body: string;
  attributes?: Record<string, MessageAttributeValue>;
  delaySeconds?: number;
};

export const enqueue = async ({ queueUrl, body, attributes, delaySeconds }: EnqueueParams) => {
  const data = await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageAttributes: attributes,
      ...(delaySeconds === undefined ? {} : { DelaySeconds: delaySeconds }),
    }),
  );
  const queueName = queueUrl.split("/").pop() || queueUrl;
  sqsLogger.info(`SQS message sent to "${queueName}". MessageID: ${data.MessageId}`);
  return data;
};

async function enqueueInternal({
  queue,
  body,
  attributes,
  delaySeconds,
}: Omit<EnqueueParams, "queueUrl"> & { queue: InternalQueue }): Promise<void> {
  if (env.INTERNAL_QUEUE_DRIVER === "bullmq") {
    await enqueueBullMq(queue, { body, delaySeconds });
    return;
  }
  const queueUrl = getInternalSqsQueueUrl(queue);
  if (!queueUrl) throw new Error(`SQS queue URL is not configured for ${queue.name}`);
  await enqueue({ queueUrl, body, attributes, delaySeconds });
}

async function enqueueInternalBatch({
  queue,
  bodies,
}: {
  queue: InternalQueue;
  bodies: Array<string>;
}): Promise<void> {
  if (env.INTERNAL_QUEUE_DRIVER === "bullmq") {
    await enqueueBullMqBatch(
      queue,
      bodies.map((body) => ({ body })),
    );
    return;
  }
  const queueUrl = getInternalSqsQueueUrl(queue);
  if (!queueUrl) throw new Error(`SQS queue URL is not configured for ${queue.name}`);

  for (let offset = 0; offset < bodies.length; offset += 10) {
    const batch = bodies.slice(offset, offset + 10);
    const result = await sqsClient.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((body, index) => ({ Id: String(index), MessageBody: body })),
      }),
    );
    if (result.Failed?.length) {
      throw new Error(`Failed to enqueue ${result.Failed.length} ${queue.name} message(s)`);
    }
  }
}

export const sendMessageToDashboardQueue = async (file_id: string, message: string) => {
  await enqueue({
    queueUrl: env.DASHBOARD_SQS_QUEUE,
    body: message || "Dashboard file processing",
    attributes: {
      file_id: { DataType: "String", StringValue: file_id },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

export const sendMessageToChatFileQueue = async (file_id: string) => {
  await enqueue({
    queueUrl: env.CHAT_FILE_SQS_QUEUE,
    body: JSON.stringify({ file_id }),
    attributes: {
      file_id: { DataType: "String", StringValue: file_id },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

/**
 * Enqueue a meeting document for vectorization by the Python worker.
 *
 * Pushed from confirm-upload once the file row exists in `meeting_documents`
 * (status `pending`). The worker keys Pinecone vectors by namespace
 * `meeting-{meetingId}` so each meeting's documents stay isolated at chat time.
 * We pass `storageKey` in the body so the worker can pull the file from S3
 * without a Mongo round-trip. No-ops (with a warning) when the queue URL is
 * unset, so the server still works before the queue is provisioned.
 */
export const sendMessageToMeetingDocsQueue = async (params: {
  fileId: string;
  meetingId: string;
  filename: string;
  storageKey: string;
}) => {
  const { fileId, meetingId, filename, storageKey } = params;

  if (!env.MEETING_DOCS_SQS_QUEUE) {
    sqsLogger.warn(
      `MEETING_DOCS_SQS_QUEUE not set — skipping vectorization enqueue for file ${fileId}`,
    );
    return;
  }

  try {
    const command = new SendMessageCommand({
      QueueUrl: env.MEETING_DOCS_SQS_QUEUE,
      MessageBody: JSON.stringify({
        action: "process",
        file_id: fileId,
        meetingId,
        filename,
        storageKey,
        namespace: `meeting-${meetingId}`,
      }),
      MessageAttributes: {
        action: { DataType: "String", StringValue: "process" },
        file_id: { DataType: "String", StringValue: fileId },
        meetingId: { DataType: "String", StringValue: meetingId },
        filename: { DataType: "String", StringValue: filename },
        environment: { DataType: "String", StringValue: env.NODE_ENV },
      },
    });

    const data = await sqsClient.send(command);
    sqsLogger.info(
      `Meeting doc ${fileId} enqueued for vectorization. MessageID: ${data.MessageId}`,
    );
  } catch (err) {
    sqsLogger.error(err, `Failed to enqueue meeting doc ${fileId} for vectorization`);
  }
};

/**
 * Tell the vectorization worker to remove a deleted file's vectors. The worker
 * looks up the file's vector ids (meeting_vector_ids) and deletes them from the
 * meeting's Pinecone namespace, so chat never surfaces a deleted document.
 * Sent per file id; folders fan out to one message per contained file.
 */
export const sendDeleteMessageToMeetingDocsQueue = async (params: {
  fileId: string;
  meetingId: string;
}) => {
  const { fileId, meetingId } = params;

  if (!env.MEETING_DOCS_SQS_QUEUE) {
    sqsLogger.warn(`MEETING_DOCS_SQS_QUEUE not set — skipping vector cleanup for file ${fileId}`);
    return;
  }

  try {
    const command = new SendMessageCommand({
      QueueUrl: env.MEETING_DOCS_SQS_QUEUE,
      MessageBody: JSON.stringify({
        action: "delete",
        file_id: fileId,
        meetingId,
        namespace: `meeting-${meetingId}`,
      }),
      MessageAttributes: {
        action: { DataType: "String", StringValue: "delete" },
        file_id: { DataType: "String", StringValue: fileId },
        meetingId: { DataType: "String", StringValue: meetingId },
        environment: { DataType: "String", StringValue: env.NODE_ENV },
      },
    });

    const data = await sqsClient.send(command);
    sqsLogger.info(
      `Meeting doc ${fileId} enqueued for vector cleanup. MessageID: ${data.MessageId}`,
    );
  } catch (err) {
    sqsLogger.error(err, `Failed to enqueue meeting doc ${fileId} for vector cleanup`);
  }
};

/**
 * SQS refuses a message over 256 KB. An email job larger than this (the daily
 * Sanction Search records email lists every record: 1,000 are about 470 KB)
 * is stored in S3, and the message carries its key; the email worker reads it
 * back before rendering. Every other email stays inline, as before.
 */
export const EMAIL_INLINE_LIMIT_BYTES = 200 * 1024;

/** Publishes a transactional email job to the SES email worker queue. */
export const sendMessageToEmailQueue = async (
  body: { template: string; toEmail: string } & Record<string, unknown>,
) => {
  if (env.EMAIL_PROVIDER === "smtp") {
    await sendEmailViaSmtp(body);
    return;
  }

  if (!env.EMAIL_SQS_QUEUE) {
    throw new Error("EMAIL_SQS_QUEUE is not configured");
  }

  let message = JSON.stringify(body);
  if (Buffer.byteLength(message) > EMAIL_INLINE_LIMIT_BYTES) {
    const payloadS3Key = `email-payloads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.json`;
    await uploadFile(payloadS3Key, Buffer.from(message), { mimeType: "application/json" });
    message = JSON.stringify({ template: body.template, toEmail: body.toEmail, payloadS3Key });
  }

  return enqueue({
    queueUrl: env.EMAIL_SQS_QUEUE,
    body: message,
    attributes: {
      template: { DataType: "String", StringValue: body.template },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

export const sendMessageToSystemDocumentProcessQueue = async (file_id: string, message: string) => {
  await enqueue({
    queueUrl: env.SYSTEM_DOCUMENT_PROCESS_SQS_QUEUE,
    body: message || "System documents processing",
    attributes: {
      file_id: { DataType: "String", StringValue: file_id },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

export const sendMessageToCompanyDocumentVectorizeQueue = async (
  documentId: string,
  userId: string,
  companyId: string,
) => {
  if (
    env.INTERNAL_QUEUE_DRIVER === "sqs" &&
    !getInternalSqsQueueUrl(INTERNAL_QUEUES.companyDocumentVectorization)
  ) {
    sqsLogger.warn(
      `${INTERNAL_QUEUES.companyDocumentVectorization.sqsEnvKey} not set — skipping vectorization enqueue for document ${documentId}`,
    );
    return;
  }

  await enqueueInternal({
    queue: INTERNAL_QUEUES.companyDocumentVectorization,
    body: JSON.stringify({ documentId, userId, companyId }),
    attributes: {
      documentId: { DataType: "String", StringValue: documentId },
      userId: { DataType: "String", StringValue: userId },
      companyId: { DataType: "String", StringValue: companyId },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

export const sendMessageToPdfTranslationQueue = async (
  payload: PdfTranslationQueuePayload,
  options: { delaySeconds?: number } = {},
) => {
  const delaySeconds = options.delaySeconds;
  if (
    delaySeconds !== undefined &&
    (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 900)
  ) {
    throw new Error("PDF translation queue delay must be an integer between 0 and 900 seconds");
  }

  return enqueueInternal({
    queue: INTERNAL_QUEUES.pdfTranslation,
    body: JSON.stringify(payload),
    delaySeconds,
    attributes: {
      jobId: { DataType: "String", StringValue: payload.jobId },
      userId: { DataType: "String", StringValue: payload.userId },
      sourceType: { DataType: "String", StringValue: payload.sourceType },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

export const sendMessageToContractDraftingQueue = async (payload: ContractDraftingQueuePayload) => {
  const attributes: Record<string, MessageAttributeValue> = {
    draftId: { DataType: "String", StringValue: payload.draftId },
    userId: { DataType: "String", StringValue: payload.userId },
    environment: { DataType: "String", StringValue: env.NODE_ENV },
  };
  if (payload.retrySectionId) {
    attributes.retrySectionId = { DataType: "String", StringValue: payload.retrySectionId };
  }

  return enqueueInternal({
    queue: INTERNAL_QUEUES.contractDrafting,
    body: JSON.stringify(payload),
    attributes,
  });
};

export const sendMessageToComplianceQueue = async (payload: ComplianceQueuePayload) => {
  const attributes: Record<string, MessageAttributeValue> = {
    jobId: { DataType: "String", StringValue: payload.jobId },
    userId: { DataType: "String", StringValue: payload.userId },
    environment: { DataType: "String", StringValue: env.NODE_ENV },
  };
  if (payload.retryLawId) {
    attributes.retryLawId = { DataType: "String", StringValue: payload.retryLawId };
  }

  return enqueueInternal({
    queue: INTERNAL_QUEUES.compliance,
    body: JSON.stringify(payload),
    attributes,
  });
};

export const sendMessageToCompanyComplianceQueue = async (
  payload: CompanyComplianceQueuePayload,
) => {
  const jobId =
    payload.kind === "parse_document"
      ? payload.jobDocId
      : payload.kind === "generate_report"
        ? payload.reportId
        : payload.requirementId;

  return enqueueInternal({
    queue: INTERNAL_QUEUES.companyCompliance,
    body: JSON.stringify(payload),
    attributes: {
      kind: { DataType: "String", StringValue: payload.kind },
      jobId: { DataType: "String", StringValue: jobId },
      companyId: { DataType: "String", StringValue: payload.companyId },
      userId: { DataType: "String", StringValue: payload.userId },
      environment: { DataType: "String", StringValue: env.NODE_ENV },
    },
  });
};

export type FileProcessQueueParams =
  | {
      userId: string;
      fileIds?: string[];
      folderIds?: string[];
      provider: "onedrive";
      s3Prefix: string;
      email: string;
      preservePath: boolean;
      dashboardFolderId?: string;
    }
  | {
      userId: string;
      files?: GoogleDriveSyncFile[];
      folders?: GoogleDriveSyncFolder[];
      provider: "google";
      s3Prefix: string;
      email: string;
      preservePath: boolean;
      dashboardFolderId?: string;
    };

export const sendMessageToSyncFileProcessQueue = async (params: FileProcessQueueParams) => {
  try {
    const MAX_BATCH_SIZE = 10;

    if (env.INTERNAL_QUEUE_DRIVER === "bullmq") {
      const jobs: Array<SyncJobPayload> = [];
      const { userId, s3Prefix, email, preservePath, dashboardFolderId } = params;

      if (params.provider === "onedrive") {
        if (!params.fileIds || !params.folderIds) {
          throw new Error("File IDs and folder IDs are required");
        }
        jobs.push(
          ...params.fileIds.map((fileId) => ({
            fileId,
            userId,
            s3Prefix,
            email,
            preservePath,
            dashboardFolderId: dashboardFolderId ?? "",
            provider: "onedrive" as const,
            type: "file" as const,
          })),
          ...params.folderIds.map((folderId) => ({
            folderId,
            userId,
            s3Prefix,
            email,
            preservePath,
            dashboardFolderId: dashboardFolderId ?? "",
            provider: "onedrive" as const,
            type: "folder" as const,
          })),
        );
      } else {
        jobs.push(
          ...(params.files ?? []).map((file) => ({
            file,
            userId,
            s3Prefix,
            email,
            preservePath,
            dashboardFolderId,
            provider: "google" as const,
            type: "file" as const,
          })),
          ...(params.folders ?? []).map((folder) => ({
            folder,
            userId,
            s3Prefix,
            email,
            preservePath,
            dashboardFolderId,
            provider: "google" as const,
            type: "folder" as const,
          })),
        );
      }

      await enqueueInternalBatch({
        queue: INTERNAL_QUEUES.sync,
        bodies: jobs.map((job) => JSON.stringify(job)),
      });
      sqsLogger.info(`Success, ${jobs.length} sync messages sent to BullMQ.`);
      return;
    }

    const queueUrl = getInternalSqsQueueUrl(INTERNAL_QUEUES.sync);
    if (!queueUrl) throw new Error("SQS queue URL is not configured for sync");

    if (params.provider === "onedrive") {
      const fileIdBatches = [];
      const folderIdBatches = [];
      const { fileIds, folderIds, userId, s3Prefix, email, preservePath, dashboardFolderId } =
        params;

      if (!fileIds || !folderIds) {
        throw new Error("File IDs and folder IDs are required");
      }

      for (let i = 0; i < fileIds.length; i += MAX_BATCH_SIZE) {
        fileIdBatches.push(fileIds.slice(i, i + MAX_BATCH_SIZE));
      }

      for (let i = 0; i < folderIds.length; i += MAX_BATCH_SIZE) {
        folderIdBatches.push(folderIds.slice(i, i + MAX_BATCH_SIZE));
      }

      const fileMessagePromises = fileIdBatches.map((batch) => {
        const entries = batch.map((fileId, index) => ({
          Id: index.toString(),
          MessageBody: JSON.stringify({
            fileId: fileId,
            userId,
            s3Prefix,
            email,
            preservePath,
            dashboardFolderId: dashboardFolderId ?? "",
            provider: "onedrive",
            type: "file",
          } satisfies SyncJobPayload),
        }));

        const params = {
          QueueUrl: queueUrl,
          Entries: entries,
        };
        return sqsClient.send(new SendMessageBatchCommand(params));
      });

      const folderMessagePromises = folderIdBatches.map((batch) => {
        const entries = batch.map((folderId, index) => ({
          Id: index.toString(),
          MessageBody: JSON.stringify({
            folderId,
            userId,
            s3Prefix,
            email,
            preservePath,
            dashboardFolderId: dashboardFolderId ?? "",
            provider: "onedrive",
            type: "folder",
          } satisfies SyncJobPayload),
        }));

        const params = {
          QueueUrl: queueUrl,
          Entries: entries,
        };
        return sqsClient.send(new SendMessageBatchCommand(params));
      });

      const results = await Promise.all([...fileMessagePromises, ...folderMessagePromises]);
      let successfulMessages = 0;
      results.forEach((result) => {
        if (result.Successful) {
          successfulMessages += result.Successful.length;
        }
        if (result.Failed && result.Failed.length > 0) {
          sqsLogger.error(`Failed to send some messages: ${JSON.stringify(result.Failed)}`);
        }
      });

      sqsLogger.info(
        `Success, ${successfulMessages} of ${
          fileIds.length + folderIds.length
        } document process messages sent.`,
      );
    }

    if (params.provider === "google") {
      const fileBatches = [];
      const folderBatches = [];

      const { files, folders, userId, s3Prefix, email, preservePath, dashboardFolderId } = params;

      const messagePromises: Array<Promise<SendMessageBatchCommandOutput>> = [];

      if (files) {
        for (let i = 0; i < files.length; i += MAX_BATCH_SIZE) {
          fileBatches.push(files.slice(i, i + MAX_BATCH_SIZE));
        }

        const fileMessagePromises = fileBatches.map((batch) => {
          const entries = batch.map((file) => ({
            Id: file.fileId,
            MessageBody: JSON.stringify({
              file: file,
              userId,
              s3Prefix,
              email,
              preservePath,
              dashboardFolderId,
              provider: "google",
              type: "file",
            } satisfies SyncJobPayload),
          }));

          const params = {
            QueueUrl: queueUrl,
            Entries: entries,
          };
          return sqsClient.send(new SendMessageBatchCommand(params));
        });

        messagePromises.push(...fileMessagePromises);
      }

      if (folders) {
        for (let i = 0; i < folders.length; i += MAX_BATCH_SIZE) {
          folderBatches.push(folders.slice(i, i + MAX_BATCH_SIZE));
        }

        const folderMessagePromises = folderBatches.map((batch) => {
          const entries = batch.map((folder) => ({
            Id: folder.folderId,
            MessageBody: JSON.stringify({
              folder: folder,
              userId,
              s3Prefix,
              email,
              preservePath,
              dashboardFolderId,
              provider: "google",
              type: "folder",
            } satisfies SyncJobPayload),
          }));

          const params = {
            QueueUrl: queueUrl,
            Entries: entries,
          };
          return sqsClient.send(new SendMessageBatchCommand(params));
        });
        messagePromises.push(...folderMessagePromises);
      }

      const results = await Promise.all(messagePromises);

      let successfulMessages = 0;
      results.forEach((result) => {
        if (result.Successful) {
          successfulMessages += result.Successful.length;
        }
        if (result.Failed && result.Failed.length > 0) {
          sqsLogger.error(`Failed to send some messages: ${JSON.stringify(result.Failed)}`);
        }
      });
      sqsLogger.info(
        `Success, ${successfulMessages} of ${(files?.length ?? 0) + (folders?.length ?? 0)} document process messages sent from Google.`,
      );
    }
  } catch (err) {
    sqsLogger.error(`Error sending document process message: ${err}`);
    throw err;
  }
};
