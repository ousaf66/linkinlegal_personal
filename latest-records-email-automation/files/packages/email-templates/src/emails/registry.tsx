import { render, toPlainText } from "react-email";
import { z } from "zod";
import { shortenLinksForText } from "./_common/written-html";
import { complianceCompletedEmailTemplate } from "./compliance-completed-email";
import { complianceFailedEmailTemplate } from "./compliance-failed-email";
import { complianceOwnerAssignedEmailTemplate } from "./compliance-owner-assigned-email";
import { complianceOwnerStatusChangedEmailTemplate } from "./compliance-owner-status-changed-email";
import { complianceReminderEmailTemplate } from "./compliance-reminder-email";
import { complianceUpdatesDigestEmailTemplate } from "./compliance-updates-digest-email";
import { complianceReviewNeededEmailTemplate } from "./compliance-review-needed-email";
import { contractDraftCompletedEmailTemplate } from "./contract-draft-completed-email";
import { contractDraftFailedEmailTemplate } from "./contract-draft-failed-email";
import { contactMessageEmailTemplate } from "./contact-message-email";
import { documentExpiryReminderEmailTemplate } from "./document-expiry-reminder-email";
import { feedbackReceivedEmailTemplate } from "./feedback-received-email";
import { paymentRequestEmailTemplate } from "./payment-request-email";
import { meetingInvitationEmailTemplate } from "./meeting-invitation-email";
import { meetingReminderEmailTemplate } from "./meeting-reminder-email";
import { courtCompanionInviteEmailTemplate } from "./court-companion-invite-email";
import { courtCompanionShareInviteEmailTemplate } from "./court-companion-share-invite-email";
import { pdfTranslationCompletedEmailTemplate } from "./pdf-translation-completed-email";
import { pdfTranslationFailedEmailTemplate } from "./pdf-translation-failed-email";
import { signatureCompletedEmailTemplate } from "./signature-completed-email";
import { signatureDeclinedEmailTemplate } from "./signature-declined-email";
import { signatureReminderEmailTemplate } from "./signature-reminder-email";
import { signatureRequestEmailTemplate } from "./signature-request-email";
import { lawyerOutreachEmailTemplate } from "./lawyer-outreach-email";
import { sanctionDigestEmailTemplate } from "./sanction-digest-email";
import { sanctionLatestRecordsEmailTemplate } from "./sanction-latest-records-email";
import { signupNurtureEmailTemplate } from "./signup-nurture-email";
import { sanctionFollowupEmailTemplate } from "./sanction-followup-email";
import { subscriptionConfirmationEmailTemplate } from "./subscription-confirmation-email";
import type { AnyEmailTemplateDefinition, EmailTemplateProps } from "./_common/template-definition";
import { welcomeEmailTemplate } from "./welcome-email";
import { workspaceMemberWelcomeEmailTemplate } from "./workspace-member-welcome-email";
import { firmAddOnRenewalNoticeEmailTemplate } from "./firm-add-on-renewal-notice-email";

/**
 * Envelope-level attachment reference — template-agnostic, so it is parsed
 * beside (not through) the template's own props schema. The worker downloads
 * the S3 object at send time and delivers via SendRawEmailCommand.
 */
const emailAttachmentSchema = z.object({
  filename: z.string().min(1),
  s3Key: z.string().min(1),
  contentType: z.string().optional(),
});

const emailAttachmentsSchema = z.array(emailAttachmentSchema).max(5).optional();

export type EmailAttachmentRef = z.infer<typeof emailAttachmentSchema>;

/**
 * Who the email should appear to come FROM. Envelope-level like attachments —
 * any template can carry it. A meeting invitation names the organizer, so the
 * recipient sees a person they know rather than a generic office mailbox, and
 * a reply reaches that person instead of a no-reply inbox.
 */
const emailSenderSchema = z
  .object({
    /** Display name, e.g. the meeting organizer's. */
    name: z.string().trim().min(1).max(120).optional(),
    /** The real person's address — replies go here, and it becomes the From
     *  address itself when SES is verified for its domain. */
    replyTo: z.string().trim().email().optional(),
  })
  .optional();

export type EmailSender = z.infer<typeof emailSenderSchema>;

export type ParsedEmailJob = {
  template: string;
  toEmail: string;
  props: EmailTemplateProps;
  definition: AnyEmailTemplateDefinition;
  attachments?: EmailAttachmentRef[];
  sender?: EmailSender;
  configurationSet?: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const emailTemplates = [
  welcomeEmailTemplate,
  courtCompanionInviteEmailTemplate,
  courtCompanionShareInviteEmailTemplate,
  workspaceMemberWelcomeEmailTemplate,
  subscriptionConfirmationEmailTemplate,
  paymentRequestEmailTemplate,
  firmAddOnRenewalNoticeEmailTemplate,
  pdfTranslationCompletedEmailTemplate,
  pdfTranslationFailedEmailTemplate,
  contractDraftCompletedEmailTemplate,
  contractDraftFailedEmailTemplate,
  complianceCompletedEmailTemplate,
  complianceReviewNeededEmailTemplate,
  complianceOwnerAssignedEmailTemplate,
  complianceOwnerStatusChangedEmailTemplate,
  complianceReminderEmailTemplate,
  complianceUpdatesDigestEmailTemplate,
  complianceFailedEmailTemplate,
  documentExpiryReminderEmailTemplate,
  meetingInvitationEmailTemplate,
  lawyerOutreachEmailTemplate,
  sanctionDigestEmailTemplate,
  meetingReminderEmailTemplate,
  signatureRequestEmailTemplate,
  signatureReminderEmailTemplate,
  signatureCompletedEmailTemplate,
  signatureDeclinedEmailTemplate,
  feedbackReceivedEmailTemplate,
  contactMessageEmailTemplate,
  signupNurtureEmailTemplate,
  sanctionFollowupEmailTemplate,
  sanctionLatestRecordsEmailTemplate,
];

const emailTemplateMap = new Map<string, AnyEmailTemplateDefinition>(
  emailTemplates.map((template) => [template.name, template]),
);

export function parseEmailJob(rawBody: string): ParsedEmailJob {
  const payload = JSON.parse(rawBody) as Record<string, unknown>;

  if (typeof payload.template !== "string" || !payload.template.trim()) {
    throw new Error("Missing required field: template.");
  }

  const definition = emailTemplateMap.get(payload.template);

  if (!definition) {
    throw new Error(`Unsupported email template: ${payload.template}.`);
  }

  const props = definition.schema.parse(payload);
  const attachments = emailAttachmentsSchema.parse(payload.attachments);
  const sender = emailSenderSchema.parse(payload.sender);
  const configurationSet =
    typeof payload.configurationSet === "string" && payload.configurationSet.trim()
      ? payload.configurationSet.trim()
      : undefined;

  return {
    template: definition.name,
    toEmail: props.toEmail,
    props,
    definition,
    attachments,
    sender,
    configurationSet,
  };
}

export async function renderEmailJob(job: ParsedEmailJob): Promise<RenderedEmail> {
  const html = await render(job.definition.render(job.props));

  return {
    subject: job.definition.subject(job.props),
    html,
    text: toPlainText(shortenLinksForText(html), {
      // Headings as written, not shouted in capitals.
      selectors: ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
    }),
  };
}

export function listEmailTemplates() {
  return [...emailTemplateMap.values()].map((definition) => ({
    name: definition.name,
    subject: definition.subject(definition.testPayload),
    testPayload: definition.testPayload,
    ...(definition.variants?.length
      ? {
          variants: definition.variants.map((variant) => ({
            key: variant.key,
            label: variant.label,
            payload: { ...definition.testPayload, ...variant.payload },
          })),
        }
      : {}),
  }));
}

export function getTestEmailJob(templateName: string) {
  const definition = emailTemplateMap.get(templateName);

  if (!definition) {
    throw new Error(`Unsupported email template: ${templateName}.`);
  }

  return {
    template: definition.name,
    ...definition.testPayload,
  };
}
