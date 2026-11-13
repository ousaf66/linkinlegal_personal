import { randomUUID } from "node:crypto";

import { Types, type Model } from "mongoose";
import * as XLSX from "xlsx";
import { isWikiSource, sanctionsSources } from "@repo/types/modules/sanctions/wiki-sources";

import { env } from "@/lib/env";
import { sendMessageToEmailQueue } from "@/lib/sqs";
import { getDocumentSignedUrl, uploadFile } from "@/lib/storage";
import { createLogger } from "@/utils/logger";

import { SanctionDatasetDescriptions } from "../models/sanction-dataset-descr.model";
import { PepModel } from "../pep.model";
import { getSanctionHistory, type SanctionHistory } from "../sanction-history.service";
import { pepSources, readFromSanctions } from "../sanction-pep.service";
import { SanctionModel } from "../sanction.model";
import {
  LatestRecordsAlertSendModel,
  LatestRecordsAlertStateModel,
  type ILatestRecordsAlertState,
} from "./latest-records-alert.model";

/**
 * Every record added to Sanction Search, delivered in a daily workbook with
 * a preview of up to ten records in the email.
 *
 * At 15:00 Pakistan time: the loader adds the day's records from 14:01 to
 * about 14:15, with a few more at 14:48 on some days (production, October and
 * November 2026). The email waits while records are still arriving, so a late
 * load is never cut in half.
 *
 * "Added" means a new document: the loader writes a new or changed record as
 * a new document, never in place (0 in-place changes in three loads checked),
 * so `_id` order catches every one of them, including those whose source
 * dates are months old (715 of the 9 November load), which a window on
 * `last_change` would miss. Each collection keeps a cursor; it moves only
 * after the email has been queued.
 *
 * A record goes on the Sanctions list, the PEP list, or both, by the rules the
 * Sanctions page searches with; a record on neither is still sent, as "Other".
 * The workbook carries every field of the record's View details page and its
 * listing history.
 */

const logger = createLogger("sanction-latest-records");

export const DEFAULT_LATEST_RECORDS_RECIPIENTS = ["mehree.alam@linkinlegal.com"];
/** Only production writes to the team unless an address list is set. */
const PRODUCTION_APP_HOST = "app.linkinlegal.com";

export const ALERT_TIMEZONE = "Asia/Karachi";
export const DAILY_HOUR = 15;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * No record added for this long: the day's load is over. Within a load records
 * arrive every minute or two; the few that follow at 14:48 on some days are
 * quiet by 14:58, so those days still go at 15:00.
 */
export const LOAD_QUIET_MS = 10 * MINUTE_MS;
/** A load still running this long after 15:00 is sent as it stands; the rest goes tomorrow. */
export const MAX_HOLD_MS = 3 * HOUR_MS;
/** A record first seen, or changed, at its source within this long is "new", or "updated". */
const RECENT_MS = 7 * DAY_MS;

/**
 * SES refuses a message over 10 MB, including the workbook and plain-text copy.
 */
const MAX_EMAIL_BYTES = 9 * 1024 * 1024;
/** Ten rows across Sanctions, PEP and Other combined; the workbook holds all rows. */
export const EMAIL_PREVIEW_LIMIT = 10;
const READ_BATCH = 2_000;
const HISTORY_CONCURRENCY = 8;
/** SES refuses an email over 10 MB; past this the workbook is linked instead. */
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
/** The longest a signed S3 link can last. */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Excel refuses a cell over 32,767 characters. */
const CELL_LIMIT = 32_000;
const STATE_ID = "state";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type RecordCollection = "sanctions-data" | "PEP_data";

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * Who gets the email. An explicit list (or "off") wins everywhere; unset, the
 * team's list on production only, so the dev and local schedulers, which run
 * the same code on a copy of the data, never write to the team.
 */
export function alertRecipients(
  setting: string | undefined = env.LATEST_RECORDS_ALERT_EMAILS,
  clientUrl: string | undefined = env.CLIENT_URL,
): string[] {
  const value = setting?.trim();
  if (value?.toLowerCase() === "off") return [];
  if (value) {
    return [
      ...new Set(
        value
          .split(/[,;\s]+/)
          .map((address) => address.trim().toLowerCase())
          .filter((address) => EMAIL.test(address)),
      ),
    ];
  }
  let host: string | undefined;
  try {
    host = clientUrl ? new URL(clientUrl).hostname : undefined;
  } catch {
    host = undefined;
  }
  return host === PRODUCTION_APP_HOST ? [...DEFAULT_LATEST_RECORDS_RECIPIENTS] : [];
}

// ── Time ─────────────────────────────────────────────────────────────────────

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

/** The instant a wall-clock hour on a given day falls at in a timezone. */
function zonedHour(year: number, month: number, day: number, hour: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour);
  const seen = zonedParts(new Date(guess), timeZone);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
  return new Date(guess - offset);
}

/** The latest 15:00 (Pakistan time) at or before `now`. */
export function dailySlot(now: Date, hour = DAILY_HOUR, timeZone = ALERT_TIMEZONE): Date {
  const today = zonedParts(now, timeZone);
  const slot = zonedHour(today.year, today.month, today.day, hour, timeZone);
  if (slot.getTime() <= now.getTime()) return slot;
  const yesterday = zonedParts(new Date(slot.getTime() - DAY_MS), timeZone);
  return zonedHour(yesterday.year, yesterday.month, yesterday.day, hour, timeZone);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "13 Nov 2026, 15:00" in Pakistan time. */
export function formatLocal(date: Date, timeZone = ALERT_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  const month = new Date(Date.UTC(2000, parts.month - 1, 1)).toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  return `${parts.day} ${month} ${parts.year}, ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** `last_change` and `first_seen` are UTC without a zone. */
export function fromSourceDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) || value.length <= 10 ? value : `${value}Z`);
}

/** "12 Nov 2026" from a source date ("2026-11-12T23:14:04" or "2026-11-12"). */
export function formatDay(value: string | undefined): string {
  if (!value) return "";
  const date = fromSourceDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type AlertPlan = { action: "daily"; slot: Date } | { action: "wait" } | { action: "idle" };

/** Send at 15:00, unless records are still arriving; then once they stop, for up to three hours. */
export function planAlert({
  now,
  state,
  lastAddedAt,
}: {
  now: Date;
  state: Pick<ILatestRecordsAlertState, "lastDailySlot">;
  lastAddedAt?: Date;
}): AlertPlan {
  const slot = dailySlot(now);
  if (state.lastDailySlot && state.lastDailySlot.getTime() >= slot.getTime()) {
    return { action: "idle" };
  }
  const quiet = !lastAddedAt || now.getTime() - lastAddedAt.getTime() >= LOAD_QUIET_MS;
  const heldTooLong = now.getTime() - slot.getTime() >= MAX_HOLD_MS;
  return quiet || heldTooLong ? { action: "daily", slot } : { action: "wait" };
}

// ── What was added ───────────────────────────────────────────────────────────

type StoredRecord = {
  _id: Types.ObjectId;
  id: string;
  caption?: string;
  schema?: string;
  datasets?: string[];
  properties?: unknown;
  first_seen?: string;
  last_change?: string;
};

const SOURCES = [
  {
    collection: "sanctions-data" as const,
    model: SanctionModel as Model<any>,
    cursor: "sanctionsCursor" as const,
  },
  { collection: "PEP_data" as const, model: PepModel as Model<any>, cursor: "pepCursor" as const },
];

/** When the newest document reached either collection, by its `_id`. */
async function lastAddedAt(): Promise<Date | undefined> {
  const newest = await Promise.all(
    SOURCES.map(({ model }) =>
      model.collection
        .find({}, { projection: { _id: 1 } })
        .sort({ _id: -1 })
        .limit(1)
        .toArray()
        .then((rows) => (rows[0]?._id as Types.ObjectId | undefined)?.getTimestamp()),
    ),
  );
  return newest
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0];
}

/** Every listed record added after `cursor`, oldest first, and the cursor to keep. */
export async function addedSince(
  model: Model<any>,
  cursor: Types.ObjectId,
  signal?: AbortSignal,
): Promise<{ records: StoredRecord[]; lastId: Types.ObjectId }> {
  const records: StoredRecord[] = [];
  let lastId = cursor;
  for (;;) {
    signal?.throwIfAborted();
    const batch = (await model.collection
      .find(
        { _id: { $gt: lastId }, target: true },
        {
          projection: {
            _id: 1,
            id: 1,
            caption: 1,
            schema: 1,
            datasets: 1,
            properties: 1,
            first_seen: 1,
            last_change: 1,
          },
        },
      )
      .sort({ _id: 1 })
      .limit(READ_BATCH)
      .toArray()) as unknown as StoredRecord[];
    if (batch.length === 0) break;
    records.push(...batch);
    lastId = batch[batch.length - 1]!._id;
    if (batch.length < READ_BATCH) break;
  }
  // A record changed twice is one document (ids are unique); keep the last copy read.
  const byId = new Map(records.filter((record) => record.id).map((record) => [record.id, record]));
  return { records: [...byId.values()], lastId };
}

// ── Which list ───────────────────────────────────────────────────────────────

export type RecordList = "sanctions" | "pep" | "other";

export type ListRules = {
  /** Every politician source (see `pep-sources.ts`). */
  politicianSources: ReadonlySet<string>;
  /** The sources the PEP collection holds. */
  heldByPep: ReadonlySet<string>;
};

/**
 * The lists a record shows on, by the Sanctions page's own rules with nothing
 * picked: Sanctions, a record on any source that is neither a politician source
 * nor Wikidata or Wikipedia; PEP, everyone in the PEP collection, and the
 * politician and Wikidata sources only the sanctions collection holds.
 */
export function listsFor(
  collection: RecordCollection,
  datasets: readonly string[],
  rules: ListRules,
): RecordList[] {
  if (collection === "PEP_data") return ["pep"];
  const lists: RecordList[] = [];
  if (datasets.some((name) => !rules.politicianSources.has(name) && !isWikiSource(name))) {
    lists.push("sanctions");
  }
  if (datasets.some((name) => readFromSanctions(name, rules.heldByPep))) lists.push("pep");
  return lists.length ? lists : ["other"];
}

// ── The report ───────────────────────────────────────────────────────────────

export type ChangeKind = "new" | "updated" | "older";

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  new: "New listing",
  updated: "Updated",
  older: "Older record, newly added",
};

/** New at its source this week, changed there this week, or an older record only now loaded. */
export function changeKind(
  record: { firstSeen?: string; lastChange?: string },
  now: Date,
): ChangeKind {
  const recent = (value?: string) =>
    Boolean(value) && now.getTime() - fromSourceDate(value!).getTime() < RECENT_MS;
  if (recent(record.firstSeen)) return "new";
  if (recent(record.lastChange)) return "updated";
  return "older";
}

export type ReportRecord = {
  list: RecordList;
  collection: RecordCollection;
  id: string;
  caption: string;
  schema?: string;
  /** The sources the page shows for it: never Wikidata on the Sanctions list. */
  datasets: string[];
  properties: Record<string, string[]>;
  firstSeen?: string;
  lastChange?: string;
  addedAt: Date;
  change: ChangeKind;
  history?: SanctionHistory;
};

export type LatestReport = Record<RecordList, ReportRecord[]>;

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value).trim()].filter(Boolean);
}

function normaliseProperties(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Object.fromEntries(
    entries
      .map(([key, items]) => [String(key), asStrings(items)] as const)
      .filter(([, items]) => items.length > 0),
  );
}

const byNewest = (a: ReportRecord, b: ReportRecord) =>
  (b.lastChange ?? "").localeCompare(a.lastChange ?? "") || a.caption.localeCompare(b.caption);

async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work));
  }
}

/** Sorts the added records into the page's lists and reads each one's listing history. */
export async function buildReport(
  added: Array<{ collection: RecordCollection; records: StoredRecord[] }>,
  now: Date,
  rules: ListRules,
  signal?: AbortSignal,
): Promise<LatestReport> {
  const report: LatestReport = { sanctions: [], pep: [], other: [] };
  const inPepCollection = new Set(
    added
      .filter((part) => part.collection === "PEP_data")
      .flatMap((part) => part.records.map((r) => r.id)),
  );
  const all: ReportRecord[] = [];

  for (const { collection, records } of added) {
    for (const stored of records) {
      const datasets = stored.datasets ?? [];
      const base = {
        collection,
        id: stored.id,
        caption:
          stored.caption?.trim() || asStrings((stored.properties as any)?.name)[0] || stored.id,
        schema: stored.schema,
        properties: normaliseProperties(stored.properties),
        firstSeen: stored.first_seen,
        lastChange: stored.last_change,
        addedAt: stored._id.getTimestamp(),
        change: changeKind({ firstSeen: stored.first_seen, lastChange: stored.last_change }, now),
      };
      for (const list of listsFor(collection, datasets, rules)) {
        // Someone both collections hold shows on the PEP list once, from the PEP collection.
        if (list === "pep" && collection === "sanctions-data" && inPepCollection.has(stored.id)) {
          continue;
        }
        const record: ReportRecord = {
          ...base,
          list,
          datasets: list === "sanctions" ? sanctionsSources(datasets) : [...datasets],
        };
        report[list].push(record);
        all.push(record);
      }
    }
  }

  // The View details page's listing history, read once per record and shared by its rows.
  const histories = new Map<string, Promise<SanctionHistory | undefined>>();
  await inBatches(all, HISTORY_CONCURRENCY, async (record) => {
    signal?.throwIfAborted();
    const key = `${record.collection}:${record.id}`;
    if (!histories.has(key)) {
      histories.set(
        key,
        getSanctionHistory(record.id, record.collection === "PEP_data" ? "pep" : "sanction").catch(
          (error) => {
            logger.warn({ error, id: record.id }, "Couldn't read a record's listing history");
            return undefined;
          },
        ),
      );
    }
    record.history = await histories.get(key);
  });

  for (const list of Object.keys(report) as RecordList[]) report[list].sort(byNewest);
  return report;
}

// ── Workbook ─────────────────────────────────────────────────────────────────

/** The topic names the View details page prints (record-fields.ts). */
const TOPICS: Record<string, string> = {
  sanction: "Sanctioned",
  "sanction.linked": "Linked to a sanctioned party",
  "sanction.counter": "Counter-sanctioned",
  debarment: "Debarred",
  "export.control": "Export controlled",
  "export.risk": "Trade risk",
  "asset.frozen": "Frozen asset",
  poi: "Person of interest",
  wanted: "Wanted",
  crime: "Crime",
  "crime.fin": "Financial crime",
  "crime.fraud": "Fraud",
  "crime.terror": "Terrorism",
  "crime.war": "War crimes",
  "crime.traffick": "Trafficking",
  "role.pep": "Politically exposed person",
  "role.rca": "Close associate of a politically exposed person",
  "role.pol": "Politician",
  "role.oligarch": "Oligarch",
  "reg.warn": "Regulatory warning",
  "reg.action": "Regulatory action",
  "mare.detained": "Detained vessel",
  "mare.shadow": "Shadow fleet",
  "mare.sts": "Ship-to-ship transfer risk",
  "corp.offshore": "Offshore",
  "corp.shell": "Shell company",
  "corp.disqual": "Disqualified director",
  "gov.soe": "State-owned enterprise",
  "fin.bank": "Bank",
};

const IDENTIFIER_LABELS: Record<string, string> = {
  idNumber: "ID",
  passportNumber: "Passport",
  registrationNumber: "Registration",
  taxNumber: "Tax",
  vatCode: "VAT",
  innCode: "INN",
  ogrnCode: "OGRN",
  leiCode: "LEI",
  swiftBic: "SWIFT/BIC",
  imoNumber: "IMO",
  mmsi: "MMSI",
  callSign: "Call sign",
  icaoCode: "ICAO",
  serialNumber: "Serial",
  wikidataId: "Wikidata",
};

const ACRONYMS = new Set([
  "bic",
  "bik",
  "cik",
  "duns",
  "icao",
  "id",
  "imo",
  "inn",
  "isin",
  "kpp",
  "lei",
  "mmsi",
  "npi",
  "ogrn",
  "okpo",
  "pep",
  "swift",
  "uei",
  "url",
  "vat",
]);

/** "registrationNumber" → "Registration number", "innCode" → "INN code". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const NAME_PROPERTIES = ["name", "alias", "weakAlias", "previousName", "firstName", "lastName"];
const LIST_TITLES: Record<RecordList, string> = {
  sanctions: "Sanctions",
  pep: "PEP",
  other: "Other",
};

const cell = (value: string) =>
  value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}…` : value;
const unique = (values: string[]) => [...new Set(values)];

export function recordUrl(record: Pick<ReportRecord, "id" | "collection">, appUrl: string): string {
  const base = `${appUrl.replace(/\/+$/, "")}/sanction/${encodeURIComponent(record.id)}/report`;
  return record.collection === "PEP_data" ? `${base}?type=pep` : base;
}

/** "Listed" / "Delisted" / "Removed from every list", as the page's listing history reads. */
export function listingStatus(history: SanctionHistory | undefined): string {
  if (!history || (history.listings.length === 0 && !history.removedFromLists)) return "";
  if (history.removedFromLists) return "Removed from every list";
  return history.currentlyListed ? "Listed" : "Delisted";
}

function sourceNames(record: ReportRecord, names: ReadonlyMap<string, string>): string[] {
  return unique(record.datasets.map((name) => names.get(name) ?? name));
}

type ColumnContext = { names: ReadonlyMap<string, string>; appUrl: string };
type WorkbookColumn = {
  header: string;
  /** Properties this column shows, so "Other details" leaves them out. */
  properties?: string[];
  read: (record: ReportRecord, context: ColumnContext) => string;
};

const readProps = (record: ReportRecord, keys: string[]) =>
  unique(keys.flatMap((key) => record.properties[key] ?? []));

const props = (header: string, keys: string[], separator = "; "): WorkbookColumn => ({
  header,
  properties: keys,
  read: (record) => readProps(record, keys).join(separator),
});

const codes = (header: string, keys: string[]): WorkbookColumn => ({
  header,
  properties: keys,
  read: (record) => unique(readProps(record, keys).map((value) => value.toUpperCase())).join(", "),
});

/** Header and value side by side, so the two can never drift apart. */
const WORKBOOK_COLUMNS: WorkbookColumn[] = [
  { header: "Change", read: (record) => CHANGE_LABELS[record.change] },
  { header: "Name", read: (record) => record.caption },
  { header: "Type", read: (record) => record.schema ?? "" },
  {
    header: "Other names",
    properties: NAME_PROPERTIES,
    read: (record) =>
      readProps(record, NAME_PROPERTIES)
        .filter((name) => name !== record.caption)
        .join("; "),
  },
  codes("Country", ["country", "jurisdiction"]),
  codes("Nationality", ["nationality", "citizenship"]),
  props("Date of birth / incorporation", ["birthDate", "incorporationDate"]),
  props("Place of birth", ["birthPlace"]),
  props("Gender", ["gender"]),
  props("Position", ["position"]),
  { header: "Listing status", read: (record) => listingStatus(record.history) },
  { header: "First listed", read: (record) => formatDay(record.history?.firstListedAt) },
  {
    header: "Delisted on",
    read: (record) =>
      record.history && !record.history.currentlyListed
        ? formatDay(record.history.lastEndedAt ?? record.history.removedFromLists?.delistedOn)
        : "",
  },
  {
    header: "Authorities",
    read: (record) =>
      unique(
        (record.history?.listings ?? []).map((listing) => listing.authority ?? "").filter(Boolean),
      ).join("; "),
  },
  props("Programme", ["program", "programId"]),
  {
    header: "Topics",
    properties: ["topics"],
    read: (record) =>
      readProps(record, ["topics"])
        .map((topic) => TOPICS[topic] ?? topic)
        .join(", "),
  },
  { header: "Sources", read: (record, { names }) => sourceNames(record, names).join("; ") },
  {
    header: "Identifiers",
    properties: Object.keys(IDENTIFIER_LABELS),
    read: (record) =>
      Object.entries(IDENTIFIER_LABELS)
        .flatMap(([key, label]) =>
          (record.properties[key] ?? []).map((value) => `${label}: ${value}`),
        )
        .join("\n"),
  },
  props("Address", ["address"], "\n"),
  props("Email", ["email"]),
  props("Phone", ["phone"]),
  props("Website", ["website"]),
  props("Notes", ["notes", "summary", "description"], "\n\n"),
  props("Source links", ["sourceUrl"], "\n"),
  {
    header: "Other details",
    // Everything no other column shows, so no field of the record is left behind.
    read: (record) =>
      Object.entries(record.properties)
        .filter(([key]) => !SHOWN_PROPERTIES.has(key))
        .map(([key, values]) => `${fieldLabel(key)}: ${values.join("; ")}`)
        .join("\n"),
  },
  { header: "First seen", read: (record) => formatDay(record.firstSeen) },
  { header: "Last change", read: (record) => (record.lastChange ?? "").replace("T", " ") },
  { header: "Added to Sanction Search", read: (record) => formatLocal(record.addedAt) },
  { header: "Record ID", read: (record) => record.id },
  { header: "LinkinLegal link", read: (record, { appUrl }) => recordUrl(record, appUrl) },
];

const SHOWN_PROPERTIES = new Set(WORKBOOK_COLUMNS.flatMap((column) => column.properties ?? []));

export const WORKBOOK_HEADERS = WORKBOOK_COLUMNS.map((column) => column.header);

/** One row per record: every field of its View details page. */
export function workbookRow(
  record: ReportRecord,
  names: ReadonlyMap<string, string>,
  appUrl: string,
): string[] {
  return WORKBOOK_COLUMNS.map((column) => cell(column.read(record, { names, appUrl })));
}

export const HISTORY_HEADERS = [
  "List",
  "Name",
  "Authority",
  "Programme",
  "Status",
  "Listed on",
  "Ended on",
  "In force",
  "Reason",
  "Source link",
  "Record ID",
];

/** One row per listing (authority and programme) of each record, as its page's history shows. */
export function historyRows(record: ReportRecord): string[][] {
  const history = record.history;
  if (!history) return [];
  const rows = history.listings.map((listing) => [
    LIST_TITLES[record.list],
    record.caption,
    listing.authority ?? "",
    listing.program ?? "",
    listing.status ?? "",
    listing.allStartDates.map(formatDay).join("; "),
    listing.allEndDates.map(formatDay).join("; "),
    listing.removed ? "No (removed from every list)" : listing.ended ? "No" : "Yes",
    listing.reason ?? "",
    listing.sourceUrl ?? "",
    record.id,
  ]);
  if (history.removedFromLists && rows.length === 0) {
    const removed = history.removedFromLists;
    rows.push([
      LIST_TITLES[record.list],
      record.caption,
      "",
      "",
      "Removed from every list",
      "",
      formatDay(removed.delistedOn ?? removed.noticedOn),
      "No",
      `Noticed on ${formatDay(removed.noticedOn)}`,
      "",
      record.id,
    ]);
  }
  return rows.map((row) => row.map(cell));
}

function sheet(rows: string[][], wide: ReadonlySet<string>) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = (rows[0] ?? []).map((header) => ({
    wch: wide.has(header)
      ? 40
      : header === "LinkinLegal link" || header === "Source link"
        ? 60
        : 16,
  }));
  if (ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };
  return ws;
}

const WIDE = new Set([
  "Name",
  "Other names",
  "Sources",
  "Notes",
  "Other details",
  "Address",
  "Reason",
  "Identifiers",
]);

/** A sheet per list with every record, then every listing. Nothing is capped. */
export function buildWorkbook(
  report: LatestReport,
  names: ReadonlyMap<string, string>,
  appUrl: string,
): Buffer {
  const book = XLSX.utils.book_new();
  for (const list of ["sanctions", "pep", "other"] as const) {
    if (list === "other" && report.other.length === 0) continue;
    const rows = [
      WORKBOOK_HEADERS,
      ...report[list].map((record) => workbookRow(record, names, appUrl)),
    ];
    XLSX.utils.book_append_sheet(book, sheet(rows, WIDE), LIST_TITLES[list]);
  }
  const history = [
    HISTORY_HEADERS,
    ...(["sanctions", "pep", "other"] as const).flatMap((list) =>
      report[list].flatMap(historyRows),
    ),
  ];
  XLSX.utils.book_append_sheet(book, sheet(history, WIDE), "Listing history");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

// ── Email ────────────────────────────────────────────────────────────────────

const short = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

function statusLine(history: SanctionHistory | undefined): string | undefined {
  const status = listingStatus(history);
  if (!status || !history) return undefined;
  if (status === "Listed") {
    return history.firstListedAt ? `Listed since ${formatDay(history.firstListedAt)}` : "Listed";
  }
  const ended = history.lastEndedAt ?? history.removedFromLists?.delistedOn;
  return ended ? `${status} ${formatDay(ended)}` : status;
}

const firstFew = (values: string[], max: number) =>
  values.slice(0, max).join("; ") + (values.length > max ? ` +${values.length - max}` : "");

/** The record's main facts in one line: the rest of its fields are in the workbook. */
export function detailsLine(record: ReportRecord): string | undefined {
  const read = (keys: string[]) => readProps(record, keys);
  const otherNames = read(NAME_PROPERTIES).filter((name) => name !== record.caption);
  const nationality = unique(
    read(["nationality", "citizenship"]).map((code) => code.toUpperCase()),
  );
  const authorities = unique(
    (record.history?.listings ?? []).map((listing) => listing.authority ?? "").filter(Boolean),
  );
  const identifiers = Object.entries(IDENTIFIER_LABELS).flatMap(([key, label]) =>
    (record.properties[key] ?? []).map((value) => `${label} ${value}`),
  );
  const parts = [
    otherNames.length ? `Also known as ${firstFew(otherNames, 3)}` : "",
    read(["birthDate"]).length ? `Born ${firstFew(read(["birthDate"]), 2)}` : "",
    read(["incorporationDate"]).length ? `Incorporated ${read(["incorporationDate"])[0]}` : "",
    nationality.length ? `Nationality ${firstFew(nationality, 3)}` : "",
    read(["position"]).length ? `Position ${firstFew(read(["position"]), 2)}` : "",
    read(["program", "programId"]).length
      ? `Programme ${firstFew(read(["program", "programId"]), 3)}`
      : "",
    authorities.length ? `Listed by ${firstFew(authorities, 3)}` : "",
    identifiers.length ? firstFew(identifiers, 3) : "",
  ].filter(Boolean);
  return parts.length ? short(parts.join(" · "), 800) : undefined;
}

function emailRow(record: ReportRecord, names: ReadonlyMap<string, string>, appUrl: string) {
  const countries = unique(record.properties.country ?? []).map((code) => code.toUpperCase());
  const status = statusLine(record.history);
  const details = detailsLine(record);
  return {
    name: short(record.caption, 300),
    change: CHANGE_LABELS[record.change],
    ...(record.schema ? { kind: short(record.schema, 60) } : {}),
    ...(countries.length
      ? {
          country: short(
            countries.slice(0, 4).join(", ") +
              (countries.length > 4 ? ` +${countries.length - 4}` : ""),
            200,
          ),
        }
      : {}),
    ...(record.datasets.length
      ? { sources: short(sourceNames(record, names).join("; "), 600) }
      : {}),
    ...(status ? { status: short(status, 80) } : {}),
    ...(record.lastChange ? { changedOn: formatDay(record.lastChange) } : {}),
    ...(details ? { details } : {}),
    url: recordUrl(record, appUrl),
  };
}

function emailList(
  records: ReportRecord[],
  preview: ReadonlySet<ReportRecord>,
  names: ReadonlyMap<string, string>,
  appUrl: string,
) {
  const count = (kind: ChangeKind) => records.filter((record) => record.change === kind).length;
  return {
    total: records.length,
    newCount: count("new"),
    updatedCount: count("updated"),
    olderCount: count("older"),
    rows: records
      .filter((record) => preview.has(record))
      .sort(byNewest)
      .map((record) => emailRow(record, names, appUrl)),
  };
}

type EmailList = ReturnType<typeof emailList>;

/** Count every record, but show only the ten newest across all three sections. */
export function buildEmailLists(
  report: LatestReport,
  names: ReadonlyMap<string, string>,
  appUrl: string,
) {
  const preview = new Set(
    [...report.sanctions, ...report.pep, ...report.other]
      .sort(byNewest)
      .slice(0, EMAIL_PREVIEW_LIMIT),
  );
  return {
    sanctions: emailList(report.sanctions, preview, names, appUrl),
    pep: emailList(report.pep, preview, names, appUrl),
    other: emailList(report.other, preview, names, appUrl),
  };
}

/** The email's size as SES receives it: rendered exactly as the worker renders it. */
async function renderedBytes(props: Record<string, unknown>): Promise<number> {
  const { parseEmailJob, renderEmailJob } = await import("@repo/email-templates");
  const job = parseEmailJob(JSON.stringify({ ...props, toEmail: "size-check@example.com" }));
  const { html, text, subject } = await renderEmailJob(job);
  return Buffer.byteLength(html) + Buffer.byteLength(text) + Buffer.byteLength(subject);
}

/** Keeps the newest share of each list's rows; the counts still say how many there are. */
export function keepNewest(list: EmailList, share: number): EmailList {
  return { ...list, rows: list.rows.slice(0, Math.floor(list.rows.length * share)) };
}

async function datasetNames(): Promise<Map<string, string>> {
  const rows = await SanctionDatasetDescriptions.find({}, { _id: 0, name: 1, description: 1 }).lean<
    Array<{ name: string; description: string }>
  >();
  return new Map(rows.map((row) => [row.name, row.description]));
}

export type SendInput = {
  report: LatestReport;
  toEmails: string[];
  now: Date;
  /** What the email covers from: the previous email, or the start of the first one's day. */
  since: Date;
  lastAddedAt?: Date;
};

export function periodLabel(since: Date): string {
  return `since ${formatLocal(since)} (Pakistan time)`;
}

export async function sendReport({ report, toEmails, now, since, lastAddedAt }: SendInput) {
  const appUrl = env.CLIENT_URL.replace(/\/+$/, "");
  const names = await datasetNames();
  const total = report.sanctions.length + report.pep.length + report.other.length;
  const local = zonedParts(now, ALERT_TIMEZONE);
  // "2026-11-13 1500", Pakistan time: the workbook's name and folder.
  const stamp = `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}${pad(local.minute)}`;
  const filename = `Sanction Search records added ${stamp}.xlsx`;

  let workbookKey: string | undefined;
  let workbookUrl: string | undefined;
  let workbookBytes = 0;
  const workbookLink = async () =>
    (
      await getDocumentSignedUrl(workbookKey!, {
        expiresIn: LINK_TTL_SECONDS,
        fileName: filename,
        mimeType: XLSX_MIME,
        disposition: "attachment",
      })
    ).url;
  if (total > 0) {
    // Uploaded first, so a failure stops the send (and the cursors) rather than
    // sending an email without the details it promises.
    const workbook = buildWorkbook(report, names, appUrl);
    workbookBytes = workbook.length;
    workbookKey = `sanctions/latest-records/${stamp.slice(0, 10)}/${randomUUID()}.xlsx`;
    await uploadFile(workbookKey, workbook, { mimeType: XLSX_MIME });
    if (workbook.length > MAX_ATTACHMENT_BYTES) workbookUrl = await workbookLink();
  }

  const lists = buildEmailLists(report, names, appUrl);
  const build = () => ({
    template: "sanction-latest-records",
    periodLabel: periodLabel(since),
    dayLabel: formatLocal(now).split(",")[0]!,
    ...lists,
    ...(workbookUrl ? { workbookUrl } : {}),
    ...(total === 0 && lastAddedAt ? { lastLoad: formatLocal(lastAddedAt) } : {}),
    pageUrl: `${appUrl}/sanction`,
    ...(workbookKey && !workbookUrl
      ? { attachments: [{ filename, s3Key: workbookKey, contentType: XLSX_MIME }] }
      : {}),
  });

  // The preview stays small. Large workbooks become links before the send
  // exceeds SES's limit; every record remains in the workbook.
  let trimmed = false;
  if (total > 0) {
    let size = await renderedBytes(build());
    if (workbookKey && !workbookUrl && size + workbookBytes * 1.37 > MAX_EMAIL_BYTES) {
      workbookUrl = await workbookLink();
    }
    for (let attempt = 0; size > MAX_EMAIL_BYTES && attempt < 5; attempt += 1) {
      const share = (MAX_EMAIL_BYTES / size) * 0.95;
      lists.sanctions = keepNewest(lists.sanctions, share);
      lists.pep = keepNewest(lists.pep, share);
      lists.other = keepNewest(lists.other, share);
      trimmed = true;
      size = await renderedBytes(build());
    }
  }
  const props = build();

  for (const toEmail of toEmails) {
    await sendMessageToEmailQueue({ ...props, toEmail });
  }

  await LatestRecordsAlertSendModel.create({
    toEmails,
    since,
    sentAt: now,
    sanctions: report.sanctions.length,
    pep: report.pep.length,
    other: report.other.length,
    workbookKey,
    workbookLinked: Boolean(workbookUrl),
  });
  logger.info(
    {
      sanctions: report.sanctions.length,
      pep: report.pep.length,
      other: report.other.length,
      linked: Boolean(workbookUrl),
      trimmed,
      toEmails: toEmails.length,
    },
    "Queued the daily Sanction Search records email",
  );
}

// ── The check ────────────────────────────────────────────────────────────────

async function loadState(now: Date): Promise<ILatestRecordsAlertState> {
  // The first email goes at the next 15:00 and reaches back to the 15:00 before
  // this one, so it carries the day's load that has just been and the next.
  const start = new Date(dailySlot(now).getTime() - DAY_MS);
  const cursor = Types.ObjectId.createFromTime(Math.floor(start.getTime() / 1000));
  const state = await LatestRecordsAlertStateModel.findOneAndUpdate(
    { _id: STATE_ID },
    {
      $setOnInsert: {
        sanctionsCursor: cursor,
        pepCursor: cursor,
        coversFrom: start,
        lastDailySlot: dailySlot(now),
      },
    },
    { upsert: true, returnDocument: "after" },
  ).lean<ILatestRecordsAlertState>();
  return state!;
}

export async function listRules(): Promise<ListRules> {
  const [politicianSources, heldByPep] = await Promise.all([
    pepSources(),
    PepModel.distinct("datasets", { target: true }) as Promise<string[]>,
  ]);
  return { politicianSources, heldByPep: new Set(heldByPep) };
}

export type AlertRunResult = {
  action: AlertPlan["action"] | "disabled" | "skipped";
  sanctions?: number;
  pep?: number;
  other?: number;
};

export async function runLatestRecordsAlert(
  now = new Date(),
  signal?: AbortSignal,
): Promise<AlertRunResult> {
  const toEmails = alertRecipients();
  if (toEmails.length === 0) return { action: "disabled" };

  const state = await loadState(now);
  if (planAlert({ now, state }).action === "idle") return { action: "idle" };

  const newest = await lastAddedAt();
  const plan = planAlert({ now, state, lastAddedAt: newest });
  if (plan.action !== "daily") return { action: plan.action };

  // Claimed before sending, so a second process cannot send it too.
  const previousSlot = state.lastDailySlot;
  const claimed = await LatestRecordsAlertStateModel.findOneAndUpdate(
    {
      _id: STATE_ID,
      ...(previousSlot ? { lastDailySlot: previousSlot } : { lastDailySlot: { $exists: false } }),
    },
    { $set: { lastDailySlot: plan.slot } },
  ).lean();
  if (!claimed) return { action: "skipped" };

  try {
    const [sanctionsAdded, pepAdded, rules] = await Promise.all([
      addedSince(SanctionModel as Model<any>, state.sanctionsCursor, signal),
      addedSince(PepModel as Model<any>, state.pepCursor, signal),
      listRules(),
    ]);
    const report = await buildReport(
      [
        { collection: "sanctions-data", records: sanctionsAdded.records },
        { collection: "PEP_data", records: pepAdded.records },
      ],
      now,
      rules,
      signal,
    );
    await sendReport({
      report,
      toEmails,
      now,
      since: state.lastDailySentAt ?? state.coversFrom,
      lastAddedAt: newest,
    });
    await LatestRecordsAlertStateModel.updateOne(
      { _id: STATE_ID },
      {
        $set: {
          sanctionsCursor: sanctionsAdded.lastId,
          pepCursor: pepAdded.lastId,
          lastDailySentAt: now,
        },
      },
    );
    return {
      action: "daily",
      sanctions: report.sanctions.length,
      pep: report.pep.length,
      other: report.other.length,
    };
  } catch (error) {
    // Give the slot back; the cursors have not moved, so the next check sends the same records.
    await LatestRecordsAlertStateModel.updateOne(
      { _id: STATE_ID, lastDailySlot: plan.slot },
      previousSlot ? { $set: { lastDailySlot: previousSlot } } : { $unset: { lastDailySlot: 1 } },
    ).catch(() => undefined);
    throw error;
  }
}
