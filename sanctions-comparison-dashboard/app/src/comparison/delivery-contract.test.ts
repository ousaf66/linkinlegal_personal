import assert from "node:assert/strict";
import { test } from "vitest";

import { independentManifestSchema, independentRecordSchema } from "./delivery-contract";

const SHA = "a".repeat(64);

const success = {
  contractVersion: 1,
  provider: "independent",
  datasetId: "us_ofac_sdn",
  snapshotId: "2026-11-12T0400Z",
  adapterVersion: "ofac-sdn@1.0.0",
  status: "success",
  sourceUrls: [
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
  ],
  publishedAt: null,
  fetchStartedAt: "2026-11-12T04:00:00Z",
  fetchCompletedAt: "2026-11-12T04:03:10+00:00",
  complete: true,
  sourceTotal: 18000,
  counts: { extracted: 75800, accepted: 75798, rejected: 2, duplicates: 0 },
  files: [{ path: "entities.ftm.jsonl", sha256: SHA, bytes: 1234, rows: 75798 }],
};

const problems = (value: unknown) => {
  const parsed = independentManifestSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
};

test("a complete successful delivery is accepted", () => {
  assert.deepEqual(problems(success), []);
});

test("a failed run must say why it failed", () => {
  const failed = {
    ...success,
    status: "failed",
    files: [],
    counts: { ...success.counts, accepted: 0 },
  };
  assert.deepEqual(problems(failed), ["error"]);
  assert.deepEqual(problems({ ...failed, error: "HTTP 503 from the publisher" }), []);
});

test("partial snapshots, row mismatches and missing payloads are refused", () => {
  assert.deepEqual(problems({ ...success, complete: false }), ["complete"]);
  assert.deepEqual(problems({ ...success, counts: { ...success.counts, accepted: 5 } }), [
    "counts.accepted",
  ]);
  assert.ok(
    problems({ ...success, files: [], counts: { ...success.counts, accepted: 0 } }).includes(
      "files",
    ),
  );
  assert.ok(problems({ ...success, fetchCompletedAt: undefined }).includes("fetchCompletedAt"));
});

test("payload files are names beside the manifest, never paths out of it", () => {
  for (const path of ["../entities.jsonl", "/tmp/x.jsonl", "sub/x.jsonl", "x.json"]) {
    assert.ok(
      problems({ ...success, files: [{ ...success.files[0], path }] }).length > 0,
      `${path} must be refused`,
    );
  }
});

test("dataset IDs are inventory IDs and the version is pinned", () => {
  assert.ok(problems({ ...success, datasetId: "US OFAC" }).includes("datasetId"));
  assert.ok(problems({ ...success, contractVersion: 2 }).includes("contractVersion"));
});

test("records are FtM entities with string-array properties and our own IDs", () => {
  const record = {
    id: "llg-us-ofac-sdn-36",
    caption: "AEROCARIBBEAN AIRLINES",
    schema: "Organization",
    properties: { name: ["AEROCARIBBEAN AIRLINES"], country: ["cu"] },
    datasets: ["us_ofac_sdn"],
    target: true,
    first_seen: "2026-11-12T04:03:10",
  };
  assert.ok(independentRecordSchema.safeParse(record).success);
  assert.ok(!independentRecordSchema.safeParse({ ...record, id: "NK-abc" }).success);
  assert.ok(!independentRecordSchema.safeParse({ ...record, schema: "organization" }).success);
  assert.ok(
    !independentRecordSchema.safeParse({ ...record, properties: { name: "AEROCARIBBEAN" } })
      .success,
  );
  // An identifier keeps its leading zeros: it is a string, never a number.
  assert.ok(
    !independentRecordSchema.safeParse({ ...record, properties: { idNumber: [7] } }).success,
  );
});
