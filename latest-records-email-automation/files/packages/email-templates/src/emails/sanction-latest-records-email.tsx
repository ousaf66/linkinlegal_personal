import { z } from "zod";
import {
  Button,
  Column,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "react-email";

import { defaultLogoUrl, EmailLayout } from "./_common/email-layout";
import { defineEmailTemplate } from "./_common/template-definition";

/**
 * Every record added to Sanction Search, for the team, once a day at 15:00
 * Pakistan time. It previews up to ten records, each with its main facts and
 * a link to its View details page; the workbook
 * (attached, or linked when too large to attach) carries every field of each.
 *
 * The full totals describe every record, including those only in the workbook.
 */

const recordRowSchema = z.object({
  name: z.string().trim().min(1).max(300),
  /** "New listing", "Updated", "Older record, newly added". */
  change: z.string().trim().min(1).max(60),
  /** Person, Company, Vessel … */
  kind: z.string().trim().max(60).optional(),
  country: z.string().trim().max(200).optional(),
  sources: z.string().trim().max(600).optional(),
  /** "Listed since 3 Nov 2026", "Delisted 12 Nov 2026". */
  status: z.string().trim().max(80).optional(),
  /** "12 Nov 2026": when the record last changed at its source. */
  changedOn: z.string().trim().max(40).optional(),
  /** "Also known as …; Born …; Nationality …; Programme …; IDs …" */
  details: z.string().trim().max(800).optional(),
  url: z.url(),
});

const listSchema = z.object({
  total: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  olderCount: z.number().int().nonnegative(),
  /** The newest records selected for this preview; ten rows at most across all lists. */
  rows: z.array(recordRowSchema).max(10),
});

const emptyList = { total: 0, newCount: 0, updatedCount: 0, olderCount: 0, rows: [] };

const sanctionLatestRecordsEmailSchema = z
  .object({
    toEmail: z.email(),
    /** "since 12 Nov 2026, 15:00 (Pakistan time)" */
    periodLabel: z.string().trim().min(1).max(200),
    /** "13 Nov 2026", for the subject line. */
    dayLabel: z.string().trim().min(1).max(40),
    sanctions: listSchema,
    pep: listSchema,
    /** Records added that show on neither list. */
    other: listSchema.optional(),
    /** A download link, when the workbook was too large to attach. */
    workbookUrl: z.url().optional(),
    /** "12 Nov 2026, 14:15": the latest load, said when nothing is new. */
    lastLoad: z.string().trim().max(40).optional(),
    pageUrl: z.url(),
    logoUrl: z.url().optional(),
  })
  .refine(
    ({ sanctions, pep, other }) =>
      sanctions.rows.length + pep.rows.length + (other?.rows.length ?? 0) <= 10,
    { message: "The email preview must contain at most ten records across all lists." },
  );

export type SanctionLatestRecordsEmailProps = z.infer<typeof sanctionLatestRecordsEmailSchema>;
type RecordRow = z.infer<typeof recordRowSchema>;
type RecordList = z.infer<typeof listSchema>;

const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;
const total = ({ sanctions, pep, other }: SanctionLatestRecordsEmailProps) =>
  sanctions.total + pep.total + (other?.total ?? 0);

function headline(props: SanctionLatestRecordsEmailProps): string {
  if (total(props) === 0) return "No new records in Sanction Search";
  return `${plural(props.sanctions.total, "sanctions record", "sanctions records")} and ${plural(
    props.pep.total,
    "PEP record",
    "PEP records",
  )} added`;
}

function subject(props: SanctionLatestRecordsEmailProps): string {
  if (total(props) === 0) return `Sanction Search, ${props.dayLabel}: no new records`;
  return `Sanction Search, ${props.dayLabel}: ${headline(props)}`;
}

function Tally({ label, list }: { label: string; list: RecordList }) {
  const parts = [
    plural(list.newCount, "new listing", "new listings"),
    `${count(list.updatedCount)} updated`,
    ...(list.olderCount ? [plural(list.olderCount, "older record", "older records")] : []),
  ];
  return (
    <Column className="w-1/2 align-top">
      <Text className="m-0 font-sans text-[12px] font-bold uppercase leading-[18px] tracking-[0.08em] text-muted">
        {label}
      </Text>
      <Text className="m-0 mt-1 text-[30px] leading-9 text-primary">{count(list.total)}</Text>
      <Text className="m-0 font-sans text-[13px] leading-5 text-body">{parts.join(" · ")}</Text>
    </Column>
  );
}

// Compact inline styles supported by email clients.
const CELL = "padding:9px 0;border-bottom:1px solid #eee5d6;font-family:Arial,Helvetica,sans-serif";
const NAME = "color:#001d47;font-size:15px;font-weight:700;text-decoration:none";
const META = "color:#776d60;font-size:13px;line-height:19px";
const BODY = "color:#4a4238;font-size:13px;line-height:19px";

function RecordLine({ row }: { row: RecordRow }) {
  const meta = [
    row.change,
    row.kind,
    row.country,
    row.status,
    row.changedOn ? `changed ${row.changedOn}` : undefined,
  ].filter(Boolean);
  return (
    <tr>
      <td style={css(CELL)}>
        <a href={row.url} style={css(NAME)}>
          {row.name}
        </a>
        <div style={css(META)}>{meta.join(" · ")}</div>
        {row.details ? <div style={css(BODY)}>{row.details}</div> : null}
        {row.sources ? <div style={css(BODY)}>Sources: {row.sources}</div> : null}
      </td>
    </tr>
  );
}

/** "a:b;c:d" as a React style object, so the strings above stay the source of truth. */
function css(rules: string): Record<string, string> {
  return Object.fromEntries(
    rules.split(";").map((rule) => {
      const [key = "", value = ""] = rule.split(/:(.*)/s);
      return [key.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value.trim()];
    }),
  );
}

function RecordSection({ title, note, list }: { title: string; note?: string; list: RecordList }) {
  if (list.total === 0) return null;
  const left = list.total - list.rows.length;
  return (
    <Section className="mb-[26px]">
      <Text className="m-0 mb-1 font-sans text-[12px] font-bold uppercase leading-[18px] tracking-[0.12em] text-gold">
        {title} · {count(list.total)}
      </Text>
      {note ? (
        <Text className="m-0 mb-1 font-sans text-[13px] leading-5 text-muted">{note}</Text>
      ) : null}
      {list.rows.length > 0 ? (
        <table width="100%" cellPadding={0} cellSpacing={0} role="presentation">
          <tbody>
            {list.rows.map((row) => (
              <RecordLine key={row.url} row={row} />
            ))}
          </tbody>
        </table>
      ) : null}
      {left > 0 ? (
        <Text className="m-0 mt-[10px] font-sans text-[13px] leading-5 text-muted">
          {list.rows.length > 0
            ? `Showing ${count(list.rows.length)} of ${count(list.total)} records. The other ${plural(left, "record is", "records are")} in the workbook.`
            : `All ${plural(list.total, "record is", "records are")} in the workbook.`}
        </Text>
      ) : null}
    </Section>
  );
}

const WORKBOOK_CONTENTS =
  "every record with every detail of its View details page: names and other names, type, countries, nationality, date of birth, position, listing status, authorities, programmes, topics, sources, identifiers, addresses, contact details, notes, source links and the link to the record. A Listing history sheet gives each listing's authority, programme, dates, status and reason.";

export function SanctionLatestRecordsEmail(props: SanctionLatestRecordsEmailProps) {
  const {
    periodLabel,
    sanctions,
    pep,
    other = emptyList,
    workbookUrl,
    lastLoad,
    pageUrl,
    logoUrl = defaultLogoUrl,
  } = props;
  const heading = headline(props);
  const empty = total(props) === 0;

  return (
    <Html lang="en">
      <Head />
      <Preview>
        {heading}, {periodLabel}
      </Preview>
      <EmailLayout logoUrl={logoUrl} maxWidth="640px">
        <Text className="m-0 mb-3 font-sans text-[12px] font-bold uppercase leading-[18px] tracking-[0.12em] text-gold">
          Sanctions & PEP · Daily 15:00
        </Text>
        <Heading className="m-0 mb-[14px] text-[30px] font-normal leading-[38px] tracking-[-0.02em] text-primary">
          {heading}
        </Heading>
        <Text className="m-0 mb-[22px] font-sans text-base leading-[25px] text-body">
          {empty
            ? `No records were added to Sanction Search ${periodLabel}.${
                lastLoad ? ` The latest load arrived on ${lastLoad}.` : ""
              }`
            : `A preview of up to 10 records added to Sanction Search ${periodLabel}, newest first. Each name opens its View details page. The Excel workbook contains every record and its full details.`}
        </Text>

        {empty ? null : (
          <>
            <Section className="mb-[26px] rounded-[8px] bg-page px-6 py-4">
              <Row>
                <Tally label="Sanctions" list={sanctions} />
                <Tally label="PEP" list={pep} />
              </Row>
            </Section>
            <RecordSection title="Sanctions" list={sanctions} />
            <RecordSection title="PEP" list={pep} />
            <RecordSection
              title="Other"
              note="Added to Sanction Search, but shown on neither the Sanctions nor the PEP list."
              list={other}
            />
            {workbookUrl ? (
              <Text className="m-0 mb-[22px] font-sans text-[14px] leading-[22px] text-body">
                The workbook is too large to attach.{" "}
                <Link href={workbookUrl} className="font-bold text-primary underline">
                  Download it here
                </Link>{" "}
                (the link works for 7 days). It has {WORKBOOK_CONTENTS}
              </Text>
            ) : (
              <Text className="m-0 mb-[22px] font-sans text-[14px] leading-[22px] text-body">
                The attached workbook has {WORKBOOK_CONTENTS}
              </Text>
            )}
          </>
        )}

        <Button
          href={pageUrl}
          className="inline-block bg-primary px-[22px] py-[14px] font-sans text-[15px] font-bold leading-5 text-paper no-underline"
        >
          Open Sanction Search
        </Button>
      </EmailLayout>
    </Html>
  );
}

const exampleRows: RecordRow[] = [
  {
    name: "Example Trading LLC",
    change: "New listing",
    kind: "Company",
    country: "RU",
    sources: "US OFAC Specially Designated Nationals (SDN) List",
    status: "Listed since 12 Nov 2026",
    changedOn: "13 Nov 2026",
    details: "Also known as ETL · Programme UKRAINE-EO13662 · INN 7707083893",
    url: "https://app.linkinlegal.com/sanction/NK-example1/report",
  },
  {
    name: "Jane Example",
    change: "Updated",
    kind: "Person",
    country: "IR",
    sources: "EU Financial Sanctions Files (FSF)",
    status: "Delisted 12 Nov 2026",
    changedOn: "12 Nov 2026",
    url: "https://app.linkinlegal.com/sanction/NK-example2/report",
  },
];

const testPayload: SanctionLatestRecordsEmailProps = {
  toEmail: "team@example.com",
  periodLabel: "since 12 Nov 2026, 15:00 (Pakistan time)",
  dayLabel: "13 Nov 2026",
  sanctions: { total: 2, newCount: 1, updatedCount: 1, olderCount: 0, rows: exampleRows },
  pep: {
    total: 1,
    newCount: 0,
    updatedCount: 1,
    olderCount: 0,
    rows: [
      {
        name: "John Example",
        change: "Updated",
        kind: "Person",
        country: "PK",
        sources: "Every Politician",
        changedOn: "13 Nov 2026",
        url: "https://app.linkinlegal.com/sanction/Q-example/report?type=pep",
      },
    ],
  },
  pageUrl: "https://app.linkinlegal.com/sanction",
};

SanctionLatestRecordsEmail.PreviewProps = testPayload;

export const sanctionLatestRecordsEmailTemplate = defineEmailTemplate<
  "sanction-latest-records",
  SanctionLatestRecordsEmailProps
>({
  name: "sanction-latest-records",
  schema: sanctionLatestRecordsEmailSchema,
  subject,
  render: (props) => <SanctionLatestRecordsEmail {...props} />,
  testPayload,
  variants: [
    {
      key: "linked",
      label: "Workbook too large to attach",
      payload: {
        workbookUrl: "https://files.example.com/records.xlsx",
        other: {
          total: 1,
          newCount: 1,
          updatedCount: 0,
          olderCount: 0,
          rows: [
            {
              name: "Ana Example",
              change: "New listing",
              kind: "Person",
              country: "CO",
              sources: "Colombian PEP Declarations",
              changedOn: "13 Nov 2026",
              url: "https://app.linkinlegal.com/sanction/NK-example3/report",
            },
          ],
        },
      },
    },
    {
      key: "nothing-new",
      label: "Nothing new",
      payload: {
        sanctions: { total: 0, newCount: 0, updatedCount: 0, olderCount: 0, rows: [] },
        pep: { total: 0, newCount: 0, updatedCount: 0, olderCount: 0, rows: [] },
        lastLoad: "12 Nov 2026, 14:15",
      },
    },
  ],
});

export default SanctionLatestRecordsEmail;
