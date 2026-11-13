import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient, type MessageAttributeValue } from "@aws-sdk/client-sqs";
import {
  parseEmailJob,
  renderEmailJob,
  type EmailAttachmentRef,
  type EmailSender,
} from "@repo/email-templates";

import { resolveJobBody } from "../payload";
import { isDailyQuotaRefusal } from "../quota";

const ses = new SESClient({
  region: process.env.SES_REGION,
  // Retry transient SES throttling before returning the SQS message.
  maxAttempts: 5,
});

const s3 = new S3Client({
  region: process.env.SES_REGION,
});

const sqs = new SQSClient({ region: process.env.SES_REGION });

/**
 * Where a job goes when the day's quota is spent. The releaser brings it back
 * as room appears. Unset, a quota refusal is retried like any other throttle —
 * which is what dead-lettered a day's mail in September, so the stack sets it.
 */
const WAITING_QUEUE_URL = process.env.WAITING_QUEUE_URL;

async function park(record: SQSEvent["Records"][number]): Promise<boolean> {
  if (!WAITING_QUEUE_URL) return false;
  const attributes = Object.fromEntries(
    Object.entries(record.messageAttributes ?? {}).map(([key, value]) => [
      key,
      { DataType: value.dataType ?? "String", StringValue: value.stringValue },
    ]),
  ) as Record<string, MessageAttributeValue>;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: WAITING_QUEUE_URL,
      MessageBody: record.body,
      ...(Object.keys(attributes).length ? { MessageAttributes: attributes } : {}),
    }),
  );
  return true;
}

type LoadedAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

/**
 * The account's send rate, enforced one record at a time.
 *
 * Records within a batch are sent in series, so this pause is a hard floor on
 * how long a batch takes: at 450 ms a single worker cannot exceed 2.2 sends/s,
 * and the event source's six workers cannot exceed 13.3/s against an SES limit
 * of 14/s. It is half of a pair — raising maxConcurrency without raising this
 * lifts the ceiling proportionally, and batching without it removes the ceiling
 * altogether, since nothing else bounds the rate independently of how fast SES
 * answers. Change the two together or not at all — the stack holds both and
 * refuses to synth a pair that could exceed the SES limit; this reads its
 * value from there.
 */
const SEND_PACING_MS = Number(process.env.SEND_PACING_MS) || 450;

const paceNextSend = () => new Promise((resolve) => setTimeout(resolve, SEND_PACING_MS));

/**
 * A failure that will fail identically on every attempt.
 *
 * The queue retries eight times before quarantining a message, which is the
 * right budget for a throttle and the wrong one for a job that can never
 * succeed: a malformed body is malformed on the eighth read too, and the eight
 * attempts are eight SES calls and eight invocations that the mail behind it
 * waits for. These are logged and the message is deleted; the dead-letter queue
 * is left to mean "we could not send this and we do not know why", which is
 * what makes its depth worth alerting on.
 */
class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * SES errors that describe the message or the account rather than the moment.
 *
 * An unverified sender is still unverified two minutes later and a rejected
 * message is rejected on its merits. Everything absent from this list —
 * throttles, timeouts, SES 5xx — is treated as transient and returned to the
 * queue, because the cost of retrying a permanent failure is wasted attempts
 * while the cost of dropping a transient one is a letter nobody receives.
 *
 * Deliberately absent: AccountSendingPausedException. A pause is account-wide
 * and usually short, and dropping every queued email for its duration is worse
 * than letting the queue hold them until sending resumes.
 */
const PERMANENT_SES_ERRORS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerified",
  "ConfigurationSetDoesNotExistException",
  "InvalidParameterValue",
]);

function isPermanent(error: unknown): boolean {
  if (error instanceof PermanentJobError) return true;
  const name = (error as { name?: string })?.name ?? "";
  return PERMANENT_SES_ERRORS.has(name);
}

/**
 * Download the referenced S3 objects. Any failure returns null — the caller
 * falls back to sending WITHOUT attachments, because delivering the email
 * matters more than the extra file.
 */
async function loadAttachments(refs: EmailAttachmentRef[]): Promise<LoadedAttachment[] | null> {
  const bucket = process.env.ATTACHMENTS_BUCKET;
  if (!bucket) {
    console.error("ATTACHMENTS_BUCKET is not configured; sending without attachments");
    return null;
  }

  try {
    return await Promise.all(
      refs.map(async (ref) => {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ref.s3Key }));
        const bytes = await res.Body?.transformToByteArray();
        if (!bytes) throw new Error(`Empty S3 object: ${ref.s3Key}`);
        return {
          filename: ref.filename,
          contentType: ref.contentType ?? "application/octet-stream",
          content: Buffer.from(bytes),
        };
      }),
    );
  } catch (error) {
    console.error("Failed to load email attachments from S3", { error });
    return null;
  }
}

/** A job the API stored in S3 because it was too large for SQS. */
async function readStoredJob(key: string): Promise<string> {
  const bucket = process.env.ATTACHMENTS_BUCKET;
  if (!bucket)
    throw new Error("ATTACHMENTS_BUCKET is not configured; cannot read a stored email job");
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString("utf-8");
  if (!body) throw new Error(`Empty stored email job: ${key}`);
  return body;
}

/** Fold base64 into 76-char lines, as MIME requires. */
function foldBase64(data: Buffer): string {
  return data.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/** RFC 2047 encode a header value when it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

/**
 * Hand-built multipart/mixed MIME message: an alternative (text + html) body
 * part followed by base64 attachment parts. SendEmailCommand cannot attach
 * files, so attachment jobs go through SendRawEmailCommand with this payload.
 */
function buildRawEmail(opts: {
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: LoadedAttachment[];
}): Buffer {
  const mixedBoundary = `mixed-${Date.now().toString(36)}-a1b2`;
  const altBoundary = `alt-${Date.now().toString(36)}-c3d4`;

  const lines: string[] = [
    `From: ${opts.from}`,
    ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(opts.text, "utf-8")),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(opts.html, "utf-8")),
    `--${altBoundary}--`,
  ];

  for (const attachment of opts.attachments) {
    const safeName = attachment.filename.replace(/"/g, "'");
    lines.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType}; name="${encodeHeader(safeName)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeHeader(safeName)}"`,
      "",
      foldBase64(attachment.content),
    );
  }

  lines.push(`--${mixedBoundary}--`, "");
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

/** Quote a display name when it contains characters that need it in a header. */
const quoteDisplayName = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

/**
 * Resolve the From / Reply-To pair for a job.
 *
 * When a job names a person — the meeting organizer, the person requesting a
 * signature — the email is sent AS them. The office mailbox is never used in
 * their place and their name is never rewritten to "… via Linkinlegal": the
 * recipient sees the person who actually sent it.
 *
 * Feedback is sent from FROM_EMAIL with the submitter as Reply-To: users do
 * not need a verified SES identity to contact support. Other person-sent jobs
 * retain their existing From identity.
 *
 * SES only accepts a Source it holds a verified identity for, so every domain
 * organizers send from must be verified in SES. An unverified one is rejected
 * outright (MessageRejected) rather than quietly re-sent from the office
 * address — the send fails and the job retries.
 */
const SYSTEM_SENDER_NAME = "LinkinLegal";

function resolveSender(sender: EmailSender, template: string): string {
  if (template === "feedback-received") sender = undefined;
  const person = sender?.replyTo?.trim();
  // System mail carries the brand as display name so inboxes don't show a bare address.
  const name = sender?.name?.trim() || (person ? "" : SYSTEM_SENDER_NAME);
  const address = person || (process.env.FROM_EMAIL ?? "").trim();
  // No Reply-To: the From already IS the person, so replies reach them.
  return name ? `${encodeHeader(quoteDisplayName(name))} <${address}>` : address;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      // Outside the pure step below: a failed S3 read is retried, not dead-lettered.
      const body = await resolveJobBody(record.body, readStoredJob);
      // Parsing and rendering are pure: given the same body they fail the same
      // way every time, so a failure here is settled on the first attempt.
      const { job, email } = await (async () => {
        try {
          const parsed = parseEmailJob(body);
          return { job: parsed, email: await renderEmailJob(parsed) };
        } catch (error) {
          throw new PermanentJobError("Email job could not be parsed or rendered", error);
        }
      })();

      const attachments = job.attachments?.length ? await loadAttachments(job.attachments) : null;
      const source = resolveSender(job.sender, job.template);
      const replyTo = job.template === "feedback-received" ? job.sender?.replyTo : undefined;

      if (attachments?.length) {
        await ses.send(
          new SendRawEmailCommand({
            ...(job.configurationSet ? { ConfigurationSetName: job.configurationSet } : {}),
            RawMessage: {
              Data: buildRawEmail({
                from: source,
                replyTo,
                to: job.toEmail,
                subject: email.subject,
                html: email.html,
                text: email.text,
                attachments,
              }),
            },
          }),
        );
      } else {
        await ses.send(
          new SendEmailCommand({
            Source: source,
            ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
            ...(job.configurationSet ? { ConfigurationSetName: job.configurationSet } : {}),
            Destination: {
              ToAddresses: [job.toEmail],
            },
            Message: {
              Subject: {
                Charset: "UTF-8",
                Data: email.subject,
              },
              Body: {
                Html: {
                  Charset: "UTF-8",
                  Data: email.html,
                },
                Text: {
                  Charset: "UTF-8",
                  Data: email.text,
                },
              },
            },
          }),
        );
      }

      console.info("Email sent", {
        messageId: record.messageId,
        toEmail: job.toEmail,
        template: job.template,
        attachments: attachments?.length ?? 0,
      });
    } catch (error) {
      // The day's quota is spent. Parked, not retried: it would be refused
      // again on every retry until the rolling window moves, and eight of
      // those is a quarter of an hour, after which the job is dead-lettered.
      // The releaser sends it when SES has room.
      if (isDailyQuotaRefusal(error)) {
        try {
          if (await park(record)) {
            console.warn("Daily quota spent; job parked until room appears", {
              messageId: record.messageId,
            });
            continue;
          }
        } catch (parkError) {
          console.error("Could not park a quota-refused job; returning it to the queue", {
            messageId: record.messageId,
            error: parkError,
          });
        }
      }

      if (isPermanent(error)) {
        // Not returned to the queue: it would fail the same way eight more
        // times. Logged at error so the address is recoverable from CloudWatch,
        // because nothing else records that this one was given up on.
        console.error("Dropped an email job that no retry can fix", {
          messageId: record.messageId,
          reason: (error as { name?: string })?.name,
          error,
        });
        continue;
      }

      console.error("Failed to process SQS email job", {
        messageId: record.messageId,
        error,
      });

      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    } finally {
      // Keep SQS bursts from exceeding the SES per-second sending rate. In a
      // finally, so a record that failed still costs its share of the budget:
      // a throttled send that returned immediately must not let the next one
      // start early and make the burst worse.
      await paceNextSend();
    }
  }

  return {
    batchItemFailures,
  };
}
