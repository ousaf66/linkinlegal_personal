import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as XLSX from "xlsx";

import type { SanctionHistory } from "../sanction-history.service";
import {
  alertRecipients,
  buildEmailLists,
  buildWorkbook,
  changeKind,
  dailySlot,
  DEFAULT_LATEST_RECORDS_RECIPIENTS,
  detailsLine,
  EMAIL_PREVIEW_LIMIT,
  fieldLabel,
  formatDay,
  formatLocal,
  HISTORY_HEADERS,
  historyRows,
  keepNewest,
  listingStatus,
  listsFor,
  LOAD_QUIET_MS,
  MAX_HOLD_MS,
  periodLabel,
  planAlert,
  recordUrl,
  WORKBOOK_HEADERS,
  workbookRow,
  type ListRules,
  type ReportRecord,
} from "./latest-records-alert.service";

const at = (iso: string) => new Date(iso);
const MINUTE = 60 * 1000;

describe("who gets it", () => {
  it("goes to the team on production only", () => {
    assert.deepEqual(
      alertRecipients(undefined, "https://app.linkinlegal.com"),
      DEFAULT_LATEST_RECORDS_RECIPIENTS,
    );
    assert.deepEqual(DEFAULT_LATEST_RECORDS_RECIPIENTS, ["mehree.alam@linkinlegal.com"]);
    assert.deepEqual(alertRecipients(undefined, "https://dev.linkinlegal.com"), []);
    assert.deepEqual(alertRecipients(undefined, "http://localhost:3000"), []);
    assert.deepEqual(alertRecipients("", "not a url"), []);
  });

  it("an address list wins anywhere, and off stops it", () => {
    assert.deepEqual(
      alertRecipients(" A@Example.com, b@example.com;a@example.com ", "http://localhost:3000"),
      ["a@example.com", "b@example.com"],
    );
    assert.deepEqual(alertRecipients("off", "https://app.linkinlegal.com"), []);
    assert.deepEqual(alertRecipients("not-an-address", "https://app.linkinlegal.com"), []);
  });
});

describe("15:00 Pakistan time", () => {
  it("is 10:00 UTC, today once it has passed and yesterday before", () => {
    assert.equal(dailySlot(at("2026-11-13T10:00:00Z")).toISOString(), "2026-11-13T10:00:00.000Z");
    assert.equal(dailySlot(at("2026-11-13T12:30:00Z")).toISOString(), "2026-11-13T10:00:00.000Z");
    assert.equal(dailySlot(at("2026-11-13T09:59:59Z")).toISOString(), "2026-11-12T10:00:00.000Z");
    // 00:30 in Karachi on the 14th is still the 13th in UTC.
    assert.equal(dailySlot(at("2026-11-13T19:30:00Z")).toISOString(), "2026-11-13T10:00:00.000Z");
  });

  it("works in a zone with summer time too", () => {
    // London, 30 Mar 2026: 15:00 BST is 14:00 UTC; the day before, 15:00 GMT is 15:00 UTC.
    assert.equal(
      dailySlot(at("2026-03-30T14:30:00Z"), 15, "Europe/London").toISOString(),
      "2026-03-30T14:00:00.000Z",
    );
    assert.equal(
      dailySlot(at("2026-03-30T13:30:00Z"), 15, "Europe/London").toISOString(),
      "2026-03-29T14:00:00.000Z",
    );
  });

  it("reads in Pakistan time", () => {
    assert.equal(formatLocal(at("2026-11-13T10:00:00Z")), "13 Nov 2026, 15:00");
    assert.equal(
      periodLabel(at("2026-11-12T10:00:00Z")),
      "since 12 Nov 2026, 15:00 (Pakistan time)",
    );
    assert.equal(formatDay("2026-11-12T23:14:04"), "12 Nov 2026");
    assert.equal(formatDay("2026-11-03"), "3 Nov 2026");
    assert.equal(formatDay(undefined), "");
  });
});

describe("when the email goes", () => {
  const sentYesterday = { lastDailySlot: at("2026-11-12T10:00:00Z") };
  const slot = at("2026-11-13T10:00:00Z");

  it("goes at 15:00 once the day's load is over, and once a day", () => {
    // Production's load: 14:01-14:15 PKT (09:01-09:15 UTC).
    assert.deepEqual(
      planAlert({ now: slot, state: sentYesterday, lastAddedAt: at("2026-11-13T09:15:00Z") }),
      { action: "daily", slot },
    );
    assert.equal(
      planAlert({ now: at("2026-11-13T10:15:00Z"), state: { lastDailySlot: slot } }).action,
      "idle",
    );
    assert.equal(
      planAlert({ now: at("2026-11-13T09:45:00Z"), state: sentYesterday }).action,
      "idle",
    );
  });

  it("includes the few records some days add at 14:48", () => {
    const plan = planAlert({
      now: slot,
      state: sentYesterday,
      lastAddedAt: at("2026-11-13T09:48:00Z"),
    });
    assert.equal(plan.action, "daily", "quiet since 14:48 is long enough by 15:00");
  });

  it("waits while a load is still arriving, then sends once it stops", () => {
    const late = at("2026-11-13T09:58:00Z");
    assert.equal(planAlert({ now: slot, state: sentYesterday, lastAddedAt: late }).action, "wait");
    assert.equal(
      planAlert({
        now: new Date(late.getTime() + LOAD_QUIET_MS),
        state: sentYesterday,
        lastAddedAt: late,
      }).action,
      "daily",
    );
  });

  it("sends a load that never stops after three hours; the rest goes tomorrow", () => {
    const now = new Date(slot.getTime() + MAX_HOLD_MS);
    assert.equal(
      planAlert({ now, state: sentYesterday, lastAddedAt: new Date(now.getTime() - MINUTE) })
        .action,
      "daily",
    );
  });

  it("sends a missed email at the first check after it", () => {
    const plan = planAlert({ now: at("2026-11-15T13:45:00Z"), state: sentYesterday });
    assert.deepEqual(plan, { action: "daily", slot: at("2026-11-15T10:00:00Z") });
  });
});

describe("which list a record is on", () => {
  const rules: ListRules = {
    politicianSources: new Set(["au_parliament", "ru_rupep", "wd_peps"]),
    heldByPep: new Set(["ru_rupep"]),
  };

  it("sorts records as the Sanctions page does", () => {
    assert.deepEqual(listsFor("sanctions-data", ["us_ofac_sdn"], rules), ["sanctions"]);
    assert.deepEqual(listsFor("sanctions-data", ["brand_new_source"], rules), ["sanctions"]);
    assert.deepEqual(listsFor("sanctions-data", ["au_parliament"], rules), ["pep"]);
    assert.deepEqual(listsFor("sanctions-data", ["us_ofac_sdn", "au_parliament"], rules), [
      "sanctions",
      "pep",
    ]);
    assert.deepEqual(listsFor("sanctions-data", ["wd_curated"], rules), ["pep"]);
    assert.deepEqual(listsFor("PEP_data", ["ru_rupep"], rules), ["pep"]);
  });

  it("keeps a record on neither list, rather than dropping it", () => {
    // A PEP-collection source carried by the sanctions collection: neither page reads it there.
    assert.deepEqual(listsFor("sanctions-data", ["ru_rupep"], rules), ["other"]);
    assert.deepEqual(listsFor("sanctions-data", [], rules), ["other"]);
  });
});

describe("what changed", () => {
  const now = at("2026-11-13T10:00:00Z");

  it("tells a new listing, an update and an older record newly loaded apart", () => {
    const kind = (firstSeen?: string, lastChange?: string) =>
      changeKind({ firstSeen, lastChange }, now);
    assert.equal(kind("2026-11-12T10:00:00", "2026-11-12T10:00:00"), "new");
    assert.equal(kind("2025-06-08T14:02:04", "2026-11-12T10:00:00"), "updated");
    assert.equal(kind("2024-01-01T00:00:00", "2024-02-01T00:00:00"), "older");
    assert.equal(kind(), "older");
  });
});

const history: SanctionHistory = {
  listings: [
    {
      authority: "Office of Foreign Assets Control",
      program: "UKRAINE-EO13662",
      status: "Active",
      startDate: "2026-11-10",
      allStartDates: ["2026-11-10"],
      allEndDates: [],
      reason: "Operating in the Russian economy.",
      sourceUrl: "https://example.gov/sdn",
      ended: false,
    },
  ],
  truncated: false,
  firstListedAt: "2026-11-10",
  currentlyListed: true,
  authorityCount: 1,
};

const record = (overrides: Partial<ReportRecord> = {}): ReportRecord => ({
  list: "sanctions",
  collection: "sanctions-data",
  id: "NK-abc",
  caption: "Example Trading LLC",
  schema: "Company",
  datasets: ["us_ofac_sdn", "unknown_source"],
  firstSeen: "2026-11-12T10:00:00",
  lastChange: "2026-11-12T10:00:00",
  addedAt: at("2026-11-12T09:05:00Z"),
  change: "new",
  history,
  properties: {
    name: ["Example Trading LLC", "Example Trading"],
    alias: ["ETL"],
    country: ["ru", "ae"],
    program: ["UKRAINE-EO13662"],
    topics: ["sanction", "crime.fin"],
    registrationNumber: ["1027700132195"],
    innCode: ["7707083893"],
    address: ["1 Example Street, Moscow"],
    notes: ["Designated for operating in the Russian economy."],
    sourceUrl: ["https://example.gov/sdn"],
    incorporationDate: ["1991-06-20"],
    sector: ["Trade"],
    ogrnCode: ["1027700132195"],
    legalForm: ["LLC"],
  },
  ...overrides,
});

const names = new Map([["us_ofac_sdn", "US OFAC Specially Designated Nationals (SDN) List"]]);
const APP = "https://app.linkinlegal.com/";

describe("the workbook", () => {
  it("holds every field of the View details page, in labelled columns", () => {
    const row = workbookRow(record(), names, APP);
    const get = (header: string) => row[WORKBOOK_HEADERS.indexOf(header)];

    assert.equal(row.length, WORKBOOK_HEADERS.length);
    assert.equal(get("Change"), "New listing");
    assert.equal(get("Name"), "Example Trading LLC");
    assert.equal(get("Type"), "Company");
    assert.equal(get("Other names"), "Example Trading; ETL");
    assert.equal(get("Country"), "RU, AE");
    assert.equal(get("Date of birth / incorporation"), "1991-06-20");
    assert.equal(get("Listing status"), "Listed");
    assert.equal(get("First listed"), "10 Nov 2026");
    assert.equal(get("Delisted on"), "");
    assert.equal(get("Authorities"), "Office of Foreign Assets Control");
    assert.equal(get("Programme"), "UKRAINE-EO13662");
    assert.equal(get("Topics"), "Sanctioned, Financial crime");
    assert.equal(
      get("Sources"),
      "US OFAC Specially Designated Nationals (SDN) List; unknown_source",
    );
    assert.equal(
      get("Identifiers"),
      "Registration: 1027700132195\nINN: 7707083893\nOGRN: 1027700132195",
    );
    assert.equal(get("Address"), "1 Example Street, Moscow");
    assert.equal(get("Notes"), "Designated for operating in the Russian economy.");
    assert.equal(get("Source links"), "https://example.gov/sdn");
    assert.equal(
      get("Other details"),
      "Sector: Trade\nLegal form: LLC",
      "fields without a column still travel",
    );
    assert.equal(get("Last change"), "2026-11-12 10:00:00");
    assert.equal(get("Added to Sanction Search"), "12 Nov 2026, 14:05");
    assert.equal(get("LinkinLegal link"), "https://app.linkinlegal.com/sanction/NK-abc/report");
  });

  it("puts every value of every property somewhere in the row", () => {
    const row = workbookRow(record(), names, APP).join("\n");
    // Topics are printed by name ("Financial crime"), as the page prints them.
    const { topics: _topics, ...rest } = record().properties;
    for (const values of Object.values(rest)) {
      for (const value of values) {
        assert.ok(row.includes(value) || row.includes(value.toUpperCase()), value);
      }
    }
  });

  it("reads a delisting as the page does", () => {
    const delisted: SanctionHistory = {
      ...history,
      listings: [
        {
          ...history.listings[0]!,
          ended: true,
          endDate: "2026-11-12",
          allEndDates: ["2026-11-12"],
        },
      ],
      currentlyListed: false,
      lastEndedAt: "2026-11-12",
    };
    const row = workbookRow(record({ history: delisted }), names, APP);
    assert.equal(row[WORKBOOK_HEADERS.indexOf("Listing status")], "Delisted");
    assert.equal(row[WORKBOOK_HEADERS.indexOf("Delisted on")], "12 Nov 2026");
    assert.equal(
      listingStatus({ ...delisted, removedFromLists: { noticedOn: "2026-11-12", datasets: [] } }),
      "Removed from every list",
    );
    assert.equal(listingStatus(undefined), "");
  });

  it("lists every listing in the history sheet", () => {
    const rows = historyRows(record());
    assert.equal(rows.length, 1);
    const get = (header: string) => rows[0]![HISTORY_HEADERS.indexOf(header)];
    assert.equal(get("List"), "Sanctions");
    assert.equal(get("Authority"), "Office of Foreign Assets Control");
    assert.equal(get("Listed on"), "10 Nov 2026");
    assert.equal(get("In force"), "Yes");
    assert.equal(get("Reason"), "Operating in the Russian economy.");
  });

  it("opens a PEP collection record as a PEP, and a sanctions collection one there", () => {
    assert.equal(
      recordUrl({ id: "Q 1", collection: "PEP_data" }, APP),
      "https://app.linkinlegal.com/sanction/Q%201/report?type=pep",
    );
    assert.equal(
      recordUrl({ id: "Q2", collection: "sanctions-data" }, APP),
      "https://app.linkinlegal.com/sanction/Q2/report",
    );
  });

  it("has a sheet per list and a listing history, with no row cap", () => {
    const many = Array.from({ length: 12_000 }, (_, index) =>
      record({ id: `NK-${index}`, caption: `Party ${index}` }),
    );
    const buffer = buildWorkbook(
      { sanctions: many, pep: [record({ list: "pep" })], other: [] },
      names,
      APP,
    );
    const book = XLSX.read(buffer, { type: "buffer" });

    assert.deepEqual(book.SheetNames, ["Sanctions", "PEP", "Listing history"]);
    const sanctions = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Sanctions!, { header: 1 });
    assert.equal(sanctions.length, 12_001, "header plus every record");
    const listings = XLSX.utils.sheet_to_json<string[]>(book.Sheets["Listing history"]!, {
      header: 1,
    });
    assert.equal(listings.length, 12_002, "header plus a listing per record, both lists");
  });

  it("adds an Other sheet only when there are such records", () => {
    const buffer = buildWorkbook(
      { sanctions: [], pep: [], other: [record({ list: "other" })] },
      names,
      APP,
    );
    assert.deepEqual(XLSX.read(buffer, { type: "buffer" }).SheetNames, [
      "Sanctions",
      "PEP",
      "Other",
      "Listing history",
    ]);
  });

  it("labels fields as a reader would", () => {
    assert.equal(fieldLabel("registrationNumber"), "Registration number");
    assert.equal(fieldLabel("innCode"), "INN code");
    assert.equal(fieldLabel("legalForm"), "Legal form");
  });
});

describe("the email's own list", () => {
  it("previews ten newest records across all lists while the workbook keeps every record", () => {
    const report = {
      sanctions: Array.from({ length: 12 }, (_, index) =>
        record({
          id: `sanction-${index}`,
          caption: `Sanction ${index}`,
          lastChange: `2026-11-${String(index + 1).padStart(2, "0")}`,
        }),
      ),
      pep: Array.from({ length: 4 }, (_, index) =>
        record({
          id: `pep-${index}`,
          caption: `PEP ${index}`,
          list: "pep",
          lastChange: `2026-11-${index + 13}`,
        }),
      ),
      other: [record({ id: "other", caption: "Other", list: "other", lastChange: "2026-11-17" })],
    };
    const lists = buildEmailLists(report, names, APP);
    const rows = [...lists.sanctions.rows, ...lists.pep.rows, ...lists.other.rows];
    assert.equal(rows.length, EMAIL_PREVIEW_LIMIT);
    assert.deepEqual(
      rows.map((row) => row.name).sort(),
      [
        "Other",
        "PEP 0",
        "PEP 1",
        "PEP 2",
        "PEP 3",
        "Sanction 7",
        "Sanction 8",
        "Sanction 9",
        "Sanction 10",
        "Sanction 11",
      ].sort(),
    );
    assert.equal(lists.sanctions.total, 12);
    assert.equal(lists.sanctions.rows[0]?.name, "Sanction 11");
    assert.equal(lists.sanctions.newCount, 12);
    assert.equal(lists.pep.total, 4);
    assert.equal(lists.other.total, 1);
    const book = XLSX.read(buildWorkbook(report, names, APP), { type: "buffer" });
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Sanctions!).length, 12);
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets.PEP!).length, 4);
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Other!).length, 1);
  });

  it("includes every row when fewer than ten records were added", () => {
    const report = { sanctions: [record()], pep: [], other: [] };
    const lists = buildEmailLists(report, names, APP);
    assert.equal(lists.sanctions.rows.length, 1);
    assert.equal(lists.sanctions.rows[0]?.name, "Example Trading LLC");
    assert.deepEqual(
      buildEmailLists({ sanctions: [], pep: [], other: [] }, names, APP).pep.rows,
      [],
    );
  });

  it("gives each record its main facts in one line", () => {
    assert.equal(
      detailsLine(record()),
      "Also known as Example Trading; ETL · Incorporated 1991-06-20 · Programme UKRAINE-EO13662 · Listed by Office of Foreign Assets Control · Registration 1027700132195; INN 7707083893; OGRN 1027700132195",
    );
    assert.equal(
      detailsLine(
        record({
          properties: {
            name: ["Jane Example"],
            birthDate: ["1970-01-02"],
            nationality: ["ir"],
            position: ["Deputy Minister"],
          },
          caption: "Jane Example",
          history: undefined,
        }),
      ),
      "Born 1970-01-02 · Nationality IR · Position Deputy Minister",
    );
    assert.equal(
      detailsLine(record({ properties: { name: ["Example Trading LLC"] }, history: undefined })),
      undefined,
    );
  });

  it("only past the size limit keeps the newest rows, and the counts stay true", () => {
    const list = {
      total: 10,
      newCount: 10,
      updatedCount: 0,
      olderCount: 0,
      rows: Array.from({ length: 10 }, (_, index) => ({ name: `Party ${index}` })),
    } as unknown as Parameters<typeof keepNewest>[0];
    const kept = keepNewest(list, 0.5);
    assert.equal(kept.total, 10);
    assert.deepEqual(
      kept.rows.map((row) => row.name),
      ["Party 0", "Party 1", "Party 2", "Party 3", "Party 4"],
    );
  });
});
