import "dotenv/config";
import { z } from "zod";

import { internalQueueEnvShape, validateInternalQueueEnv } from "./queues/config";

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.string().optional(),
  CLIENT_URLS: z.string().transform((value): Array<string> => value.split(",")),
  CLIENT_URL: z.string(),
  WEB_URL: z.string(),
  BACKEND_URL: z.string(),
  SIGNUP_SLACK_WEBHOOK_URL: z.url().optional(),
  /** Where scheduled health checks post what they find. Logged regardless. */
  OPS_ALERT_SLACK_WEBHOOK_URL: z.url().optional(),
  /** Expo access token, needed only if "enhanced push security" is on for the mobile app's Expo project. */
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  /** PostHog project token (the public site's NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN). Unset = payments are not recorded in PostHog. */
  POSTHOG_PROJECT_TOKEN: z.string().min(1).optional(),
  POSTHOG_HOST: z.url().default("https://us.i.posthog.com"),
});

export const loggerEnvSchema = z.object({
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  LOG_FILE: z.string().optional(),
  SERVICE_NAME: z.string().default("api"),
});

export const databaseEnvSchema = z.object({
  MONGO_URI: z.string(),
  /** UTC cron for the sanctions search_names / search_keys refresh. */
  SANCTIONS_SEARCH_NAMES_CRON: z.string().min(1),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string(),
  REDIS_SSL: z.enum(["true", "false"]),
});

export const storageEnvSchema = z.object({
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  AWS_REGION: z.string(),
  AWS_BUCKET_NAME: z.string(),
});

export const emailEnvSchema = z.object({
  EMAIL_PROVIDER: z.enum(["ses", "smtp"]).default("ses"),
  EMAIL_HOST: z.string(),
  EMAIL_USER: z.string(),
  EMAIL_PASS: z.string(),
  EMAIL_FROM: z.string(),
  EMAIL_SECURE: z.enum(["true", "false"]),
  EMAIL_PORT: z.string().optional(),
  EMAIL_ENABLED: z.enum(["true", "false"]),
});

export const queueEnvSchema = z.object({
  INTERNAL_QUEUE_DRIVER: z.enum(["sqs", "bullmq"]).default("sqs"),
  SQS_ACCESS_KEY: z.string().min(1),
  SQS_SECRET_KEY: z.string().min(1),
  SQS_REGION: z.string().min(1),
  DASHBOARD_SQS_QUEUE: z.url(),
  CHAT_FILE_SQS_QUEUE: z.url(),
  SYSTEM_DOCUMENT_PROCESS_SQS_QUEUE: z.url(),
  ...internalQueueEnvShape,
  PDF_TRANSLATION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  EMAIL_SQS_QUEUE: z.url().optional(),
  /** Filled by SNS with SES's events; read by the ses-events worker only. */
  SES_EVENTS_SQS_QUEUE: z.url().optional(),
  /** The only SNS topic whose SES events (and subscription confirmations) the public endpoint accepts. Unset rejects them all. */
  SES_EVENTS_TOPIC_ARN: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  OUTREACH_FROM_EMAIL: z.string().email().optional(),
  OUTREACH_FROM_NAME: z.string().optional(),
  OUTREACH_CONFIGURATION_SET: z.string().optional(),
  DIGEST_FROM_EMAIL: z.string().email().optional(),
  DIGEST_FROM_NAME: z.string().optional(),
  DIGEST_CONFIGURATION_SET: z.string().optional(),
  /**
   * Who gets the daily Sanction Search records email (comma-separated), or "off".
   * Unset: the team's default list, and only where CLIENT_URL is the production
   * app, so dev and local schedulers never write to the team.
   */
  LATEST_RECORDS_ALERT_EMAILS: z.string().optional(),
  /** Who approves every digest run, comma-separated. Empty keeps the list in digest-approvers.ts. */
  DIGEST_APPROVER_EMAILS: z.string().optional(),
  MEETING_DOCS_SQS_QUEUE: z.url().optional(),
});

export const billingEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  /** "1" adds a second, routerless API product so the multi-product flow can be tested by hand. */
  API_TEST_PRODUCTS: z.enum(["0", "1"]).optional(),
});

export const retrievalEnvSchema = z.object({
  PINECONE_API_KEY: z.string(),
  PINECONE_INDEX_NAME: z.string(),
  PINECONE_USER_INDEX_NAME: z.string().optional(),
  PINECONE_COMPANY_DOCS_INDEX_NAME: z.string().optional(),
  PINECONE_CHATBOT_INDEX_NAME: z.string().default("chat-bot"),
  PINECONE_REGION: z.string(),
  RETRIEVAL_RERANK_ENABLED: z.enum(["true", "false"]).optional(),
  RETRIEVAL_RERANK_MODEL: z.string().optional(),
  RETRIEVAL_RERANK_POOL_MULTIPLIER: z.coerce.number().min(1).optional(),
  RETRIEVAL_RERANK_POOL_CAP: z.coerce.number().int().min(1).optional(),
  INTERNAL_KNOWLEDGE_CONTRACT_NAMESPACE: z.string().optional(),
});

export const sessionEnvSchema = z.object({
  SESSION_SECRET: z.string(),
  DIRECTORY_PUBLIC_API_KEY: z.string().optional(),
  MAX_SESSIONS: z.coerce.number().int().min(1),
  COOKIE_NAME: z.string(),
});

export const onlyOfficeEnvSchema = z.object({
  ONLY_OFFICE_API_SECRET: z.string(),
  ONLY_OFFICE_NAV_PLUGIN_URL: z.url().optional(),
  ONLY_OFFICE_NAV_PLUGIN_GUID: z.string().optional(),
});

export const meetingProviderEnvSchema = z.object({
  ZOOM_CLIENT_ID: z.string().trim().min(1),
  ZOOM_CLIENT_SECRET: z.string().trim().min(1),
  ZOOM_REDIRECT_URI: z.string().trim().min(1),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  AZURE_CLIENT_ID: z.string(),
  AZURE_CLIENT_SECRET: z.string(),
  AZURE_AUTHORITY: z.string().optional(),
  MSAL_ENC_KEY: z.string(),
});

export const complianceEnvSchema = z.object({
  COMPLIANCE_PROFILE_MODEL: z.string(),
  COMPLIANCE_LAW_DISCOVERY_MODEL: z.string(),
  COMPLIANCE_EXTRACTION_MODEL: z.string(),
  COMPLIANCE_STRUCTURING_MODEL: z.string(),

  COMPANY_COMPLIANCE_EXTRACT_MODEL: z.string(),
  COMPANY_COMPLIANCE_EXTRACT_FALLBACK_MODEL: z.string(),
});

export const companyEnvSchema = z.object({
  COMPANY_CHAT_MODEL: z.string(),
});

export const aiEnvSchema = z.object({
  AI_PROVIDER: z.enum(["openai", "google", "openrouter"]).optional(),
  OPENAI_API_KEY: z.string(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_APP_NAME: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string(),
  OPENROUTER_PDF_TRANSLATION_MODEL: z.string(),
  OPENROUTER_PDF_TRANSLATION_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  DRAFT_MODE_MODEL: z.string(),
  OPENAI_CODEX_API_KEY: z.string().optional(),
});

export const workosEnvSchema = z.object({
  WORKOS_API_KEY: z.string().min(1),
  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_ISSUER: z.url(),
  WORKOS_WEBHOOK_SECRET: z.string().min(1).optional(),
});

// The Claude connector (remote MCP server). Leave MCP_AUTHKIT_DOMAIN unset to keep /mcp off.
export const mcpEnvSchema = z.object({
  MCP_AUTHKIT_DOMAIN: z
    .url()
    .optional()
    .describe(
      "WorkOS AuthKit domain that issues the connector's OAuth tokens; unset disables /mcp",
    ),
  MCP_RESOURCE_URL: z
    .url()
    .optional()
    .describe("Public URL of the MCP endpoint; defaults to BACKEND_URL + /mcp"),
});

export const meetingsEnvSchema = z.object({
  MEETING_AI_PY_URL: z.url().optional(),
  TRANSCRIPT_LANGUAGE: z
    .string()
    .default("English")
    .describe("Language used to store every transcript; blank preserves the spoken language"),
  MEETING_BOT_URL: z
    .union([z.url(), z.literal("")])
    .optional()
    .transform((value) => value || undefined)
    .describe("Notetaker service URL; blank disables it"),
  MEETING_BOT_API_TOKEN: z
    .string()
    .optional()
    .describe("Shared secret presented to the notetaker service"),
  MEETING_BOT_NAME: z.string().optional().describe("Notetaker display name in calls"),
  MEETING_BOT_PUBLIC_URL: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .describe("Browser-accessible notetaker sign-in URL; falls back to MEETING_BOT_URL"),
  MEETING_BOT_CALLBACK_URL: z
    .union([z.url(), z.literal("")])
    .optional()
    .transform((value) => value || undefined)
    .describe("API URL that receives notetaker callbacks; defaults to BACKEND_URL"),
  MEETING_BOT_ECS_CLUSTER: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .describe("ECS cluster used to run one notetaker task per meeting"),
  MEETING_BOT_ECS_TASK_DEFINITION: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .describe("ECS task definition used for notetaker tasks"),
  MEETING_BOT_ECS_SUBNETS: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .describe("Comma-separated ECS subnet IDs across availability zones"),
  MEETING_BOT_ECS_SECURITY_GROUPS: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .describe("Comma-separated egress-only ECS security group IDs"),
  MEETING_BOT_ECS_CONTAINER_NAME: z
    .string()
    .default("notetaker")
    .describe("Container name in the ECS task definition"),
  MEETING_BOT_ECS_ASSIGN_PUBLIC_IP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true")
    .describe("Disable only for private subnets with NAT access"),
});

export const internalEnvSchema = z.object({
  INTERNAL_API_KEY: z.string().min(32),
  REVALIDATE_SECRET: z.string().optional(),
});

const Env = z
  .object({
    ...serverEnvSchema.shape,
    ...loggerEnvSchema.shape,
    ...databaseEnvSchema.shape,
    ...redisEnvSchema.shape,
    ...storageEnvSchema.shape,
    ...emailEnvSchema.shape,
    ...queueEnvSchema.shape,
    ...billingEnvSchema.shape,
    ...retrievalEnvSchema.shape,
    ...sessionEnvSchema.shape,
    ...onlyOfficeEnvSchema.shape,
    ...meetingProviderEnvSchema.shape,
    ...complianceEnvSchema.shape,
    ...companyEnvSchema.shape,
    ...aiEnvSchema.shape,
    ...workosEnvSchema.shape,
    ...mcpEnvSchema.shape,
    ...meetingsEnvSchema.shape,
    ...internalEnvSchema.shape,
  })
  .superRefine(validateInternalQueueEnv)
  .transform((data) => ({
    ...data,
    isprod: data.NODE_ENV === "production",
  }));

export const env = Env.parse(process.env);

export function envOrDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}
