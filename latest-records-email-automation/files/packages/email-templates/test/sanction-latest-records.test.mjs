import assert from "node:assert/strict";
import { test } from "node:test";

import { getTestEmailJob, parseEmailJob, renderEmailJob } from "../dist/index.mjs";

const base = getTestEmailJob("sanction-latest-records");
const render = (payload) => renderEmailJob(parseEmailJob(JSON.stringify(payload)));
const text = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const none = { total: 0, newCount: 0, updatedCount: 0, olderCount: 0, rows: [] };
const many = (count, prefix) => ({
  total: count,
  newCount: count,
  updatedCount: 0,
  olderCount: 0,
  rows: Array.from({ length: count }, (_, i) => ({
    name: `${prefix} ${i + 1}`,
    change: "New listing",
    kind: "Company",
    country: "RU",
    sources: "US OFAC Specially Designated Nationals (SDN) List",
    changedOn: "13 Nov 2026",
    details: "Also known as Example · Programme RUSSIA-EO14024",
    url: `https://app.linkinlegal.com/sanction/${prefix}-${i + 1}/report`,
  })),
});

test("sanction-latest-records: counts both lists and links each record to its details", async () => {
  const out = await render(base);
  const body = text(out.html);

  assert.equal(
    out.subject,
    "Sanction Search, 13 Nov 2026: 2 sanctions records and 1 PEP record added",
  );
  assert.ok(body.includes("1 new listing · 1 updated"));
  assert.ok(body.includes("New listing · Company · RU · Listed since 12 Nov 2026"));
  assert.ok(body.includes("Also known as ETL · Programme UKRAINE-EO13662 · INN 7707083893"));
  assert.ok(body.includes("Delisted 12 Nov 2026"));
  assert.ok(body.includes("The attached workbook has every record with every detail"));
  assert.ok(body.includes("Listing history sheet"));
  assert.ok(!body.includes("This email lists the newest"), "every record is listed");
  assert.match(out.html, /href="https:\/\/app\.linkinlegal\.com\/sanction\/NK-example1\/report"/);
  assert.match(
    out.html,
    /href="https:\/\/app\.linkinlegal\.com\/sanction\/Q-example\/report\?type=pep"/,
  );
});

test("sanction-latest-records: shows up to ten records and sends readers to the complete workbook", async () => {
  const out = await render({
    ...base,
    sanctions: { ...many(7, "Party"), total: 1000 },
    pep: { ...many(3, "Person"), total: 300 },
  });
  const body = text(out.html);

  assert.ok(out.subject.includes("1,000 sanctions records and 300 PEP records added"));
  for (const name of ["Party 1 ", "Party 7 ", "Person 3 "]) {
    assert.ok(body.includes(name), name);
  }
  assert.equal((out.html.match(/\/sanction\/Party-\d+\/report/g) ?? []).length, 7);
  assert.ok(
    body.includes("Showing 7 of 1,000 records. The other 993 records are in the workbook."),
  );
  assert.ok(body.includes("Showing 3 of 300 records. The other 297 records are in the workbook."));
  assert.ok(body.includes("preview of up to 10 records"));
});

test("sanction-latest-records: rejects more than ten preview rows, including across sections", () => {
  assert.throws(() =>
    parseEmailJob(JSON.stringify({ ...base, sanctions: many(11, "Party"), pep: none })),
  );
  assert.throws(() =>
    parseEmailJob(JSON.stringify({ ...base, sanctions: many(6, "Party"), pep: many(5, "Person") })),
  );
});

test("sanction-latest-records: directs a list with no preview rows to the workbook", async () => {
  const out = await render({
    ...base,
    sanctions: { ...none, total: 5000 },
    pep: many(10, "Person"),
  });
  assert.ok(text(out.html).includes("All 5,000 records are in the workbook."));
});

test("sanction-latest-records: lists records on neither page in their own section", async () => {
  const out = await render({ ...base, other: many(2, "Politician") });
  const body = text(out.html);

  assert.ok(body.includes("Other · 2"));
  assert.ok(body.includes("shown on neither the Sanctions nor the PEP list"));
  assert.ok(body.includes("Politician 2"));
});

test("sanction-latest-records: a workbook too large to attach is linked instead", async () => {
  const out = await render({ ...base, workbookUrl: "https://files.example.com/records.xlsx" });
  const body = text(out.html);

  assert.ok(body.includes("too large to attach"));
  assert.ok(body.includes("works for 7 days"));
  assert.match(out.html, /href="https:\/\/files\.example\.com\/records\.xlsx"/);
});

test("sanction-latest-records: nothing new still sends, and says when the last load came", async () => {
  const out = await render({ ...base, sanctions: none, pep: none, lastLoad: "12 Nov 2026, 14:15" });
  const body = text(out.html);

  assert.equal(out.subject, "Sanction Search, 13 Nov 2026: no new records");
  assert.ok(body.includes("No records were added to Sanction Search"));
  assert.ok(body.includes("The latest load arrived on 12 Nov 2026, 14:15"));
  assert.ok(!body.includes("workbook"));
});

test("sanction-latest-records: carries the workbook as an attachment", () => {
  const job = parseEmailJob(
    JSON.stringify({
      ...base,
      attachments: [{ filename: "records.xlsx", s3Key: "sanctions/latest-records/x.xlsx" }],
    }),
  );

  assert.equal(job.attachments?.[0]?.s3Key, "sanctions/latest-records/x.xlsx");
});
