import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildDatasetRows,
  categoryOfTags,
  countryRows,
  sideTotals,
  UNKNOWN_COUNTRY,
  type RegistryRowInput,
  type SideStats,
} from "./compute";

const side = (partial: Partial<SideStats>): SideStats => ({
  totals: { records: 0, entities: 0, bytes: 0 },
  datasets: [],
  countries: [],
  datasetCountries: [],
  ...partial,
});

test("a source's category is its strongest list tag", () => {
  assert.equal(categoryOfTags(["list.export", "list.sanction"]), "sanctions");
  assert.equal(categoryOfTags(["list.sanction.counter"]), "sanctions");
  assert.equal(categoryOfTags(["list.pep", "list.pep.bulk"]), "pep");
  assert.equal(categoryOfTags(["list.enforcement", "list.export"]), "crime");
  assert.equal(categoryOfTags(["list.debarment", "sector.health"]), "debarment");
  assert.equal(categoryOfTags(["list.regulatory", "list.risk"]), "regulatory");
  assert.equal(categoryOfTags(["sector.maritime"]), "other");
  assert.equal(categoryOfTags([]), "other");
  // A prefix match must be a whole tag segment.
  assert.equal(categoryOfTags(["list.sanctionsish"]), "other");
});

test("totals count sources with data and known countries only", () => {
  const totals = sideTotals(
    side({
      totals: { records: 10, entities: 4, bytes: 1000 },
      datasets: [
        { id: "a", records: 10, entities: 4, bytes: 1000 },
        { id: "b", records: 0, entities: 0, bytes: 0 },
      ],
      countries: [
        { code: "ru", entities: 3 },
        { code: UNKNOWN_COUNTRY, entities: 1 },
      ],
    }),
  );
  assert.deepEqual(totals, { records: 10, entities: 4, bytes: 1000, datasets: 1, countries: 1 });
  assert.equal(sideTotals(undefined), null);
});

const registry: RegistryRowInput[] = [
  {
    datasetId: "us_ofac_sdn",
    title: "OFAC SDN",
    issuerCountry: "United States",
    category: "sanctions",
    workStatus: "validated",
    inventoryEntities: 18000,
    independent: {
      snapshotId: "2026-11-12",
      importedAt: new Date("2026-11-12T05:00:00Z"),
      fetchCompletedAt: new Date("2026-11-12T04:00:00Z"),
    },
  },
  { datasetId: "pk_nacta", title: "NACTA", category: "sanctions", workStatus: "not_started" },
];

test("every inventory source is a row, with or without data, then the uninventoried ones", () => {
  const rows = buildDatasetRows({
    registry,
    baseline: side({
      datasets: [
        { id: "us_ofac_sdn", records: 75798, entities: 21605, bytes: 1, lastSeen: "2026-09-19" },
        { id: "ext_gleif", records: 9, entities: 9, bytes: 1 },
      ],
    }),
    independent: side({
      datasets: [{ id: "us_ofac_sdn", records: 30000, entities: 19000, bytes: 1 }],
    }),
    titles: new Map([["ext_gleif", "GLEIF LEI register"]]),
  });

  assert.deepEqual(
    rows.map((row) => [row.datasetId, row.inInventory]),
    [
      ["us_ofac_sdn", true],
      ["pk_nacta", true],
      ["ext_gleif", false],
    ],
  );
  const [ofac, nacta, gleif] = rows;
  assert.equal(ofac?.baseline?.entities, 21605);
  assert.equal(ofac?.baseline?.lastSeen, "2026-09-19");
  assert.equal(ofac?.independent?.entities, 19000);
  assert.equal(ofac?.independent?.snapshotId, "2026-11-12");
  assert.equal(ofac?.independent?.fetchedAt, "2026-11-12T04:00:00.000Z");
  assert.equal(nacta?.baseline, null);
  assert.equal(nacta?.independent, null);
  assert.equal(nacta?.workStatus, "not_started");
  assert.equal(gleif?.title, "GLEIF LEI register");
  assert.equal(gleif?.category, "other");
  assert.equal(gleif?.workStatus, undefined);
});

test("countries: distinct overall, per-source sums when sources are picked", () => {
  const baseline = side({
    countries: [
      { code: "ru", entities: 10 },
      { code: "ir", entities: 4 },
    ],
    datasetCountries: [
      { d: "a", c: "ru", n: 7 },
      { d: "b", c: "ru", n: 5 },
      { d: "b", c: "ir", n: 4 },
    ],
  });
  const independent = side({
    countries: [{ code: "ru", entities: 6 }],
    datasetCountries: [{ d: "a", c: "ru", n: 6 }],
  });

  const all = countryRows({ baseline, independent });
  assert.equal(all.distinct, true);
  assert.deepEqual(all.rows, [
    { code: "ru", baseline: 10, independent: 6 },
    { code: "ir", baseline: 4, independent: 0 },
  ]);

  const one = countryRows({ baseline, independent, datasets: new Set(["a"]) });
  assert.equal(one.distinct, true);
  assert.deepEqual(one.rows, [{ code: "ru", baseline: 7, independent: 6 }]);

  // Two picked sources: a party on both counts twice (7 + 5 > the 10 distinct).
  const two = countryRows({ baseline, independent, datasets: new Set(["a", "b"]) });
  assert.equal(two.distinct, false);
  assert.deepEqual(two.rows[0], { code: "ru", baseline: 12, independent: 6 });
});
