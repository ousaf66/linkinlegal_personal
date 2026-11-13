import assert from "node:assert/strict";
import { test } from "vitest";

import { getDatasetDetail, getSummary, listDatasets } from "./service";
import { TEST_SCRAPED_SOURCES, testData } from "./test-data";
import inventory from "./source-inventory.json";

test("every inventory source is listed, and only those", () => {
  const { rows, dataSource } = listDatasets();
  assert.equal(dataSource, "test");
  assert.equal(rows.length, inventory.sources.length);
  assert.ok(rows.every((row) => row.inInventory));
});

test("the feed side follows each source's catalogue count", () => {
  const ofac = inventory.sources.find((source) => source.id === "us_ofac_sdn")!;
  const row = listDatasets().rows.find((candidate) => candidate.datasetId === "us_ofac_sdn")!;
  assert.equal(row.baseline?.entities, ofac.inventoryEntities);
});

test("only the test sources have a scraper side, each validated with a delivery", () => {
  const { rows } = listDatasets();
  const scraped = rows
    .filter((row) => row.independent)
    .map((row) => row.datasetId)
    .sort();
  assert.deepEqual(scraped, [...TEST_SCRAPED_SOURCES].sort());
  for (const id of TEST_SCRAPED_SOURCES) {
    const detail = getDatasetDetail(id);
    assert.equal(detail.row.workStatus, "validated");
    assert.ok(detail.runs.some((run) => run.status === "imported"));
  }
});

test("each source's countries add up to its parties, on both sides", () => {
  const data = testData();
  for (const side of [data.baseline, data.independent]) {
    const byDataset = new Map<string, number>();
    for (const pair of side.datasetCountries) {
      byDataset.set(pair.d, (byDataset.get(pair.d) ?? 0) + pair.n);
    }
    for (const dataset of side.datasets) {
      assert.equal(byDataset.get(dataset.id) ?? 0, dataset.entities, dataset.id);
    }
  }
});

test("the summary adds up and the statuses cover all 477 sources", () => {
  const summary = getSummary();
  assert.equal(summary.inventory.sources, 477);
  assert.equal(
    Object.values(summary.inventory.byStatus).reduce((sum, n) => sum + n, 0),
    477,
  );
  assert.equal(summary.inventory.byStatus.validated, TEST_SCRAPED_SOURCES.length);
  assert.equal(summary.inventory.byStatus.blocked, 2);
  assert.equal(summary.independent.datasets, TEST_SCRAPED_SOURCES.length);
  assert.ok(summary.baseline.entities > summary.independent.entities);
});

test("the same figures every time", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(getSummary())),
    JSON.parse(JSON.stringify(getSummary())),
  );
});

test("an unknown source is an error, not an empty page", () => {
  assert.throws(() => getDatasetDetail("not_a_source"), /No source not_a_source/);
});
