import type { IndependentRunDto, WorkStatus } from "./types";

import { UNKNOWN_COUNTRY, type DatasetStats, type SideStats } from "./compute";
import inventory from "./source-inventory.json";

/**
 * TEST DATA, so the comparison page can be seen before any scraper runs.
 *
 * Nothing here reads, copies or writes a database. The feed side takes each
 * source's party count from the supplied inventory (the provider's own catalogue,
 * 10 Nov 2026) and spreads it over countries by a fixed rule; the scraper side
 * is invented for a dozen core sanctions lists. No person, company or record is
 * made up: only counts. Replace this module with the real sides after the
 * scrapers run.
 */

/** Fixed, so every load and every test sees the same figures. */
export const TEST_DATA_GENERATED_AT = "2026-11-11T06:30:00.000Z";

const REFERENCE_DAY = Date.parse("2026-11-10T00:00:00Z");

/** Core sanctions lists given invented scraper deliveries. */
export const TEST_SCRAPED_SOURCES = [
  "us_ofac_sdn",
  "un_sc_sanctions",
  "eu_fsf",
  "gb_fcdo_sanctions",
  "ch_seco_sanctions",
  "au_dfat_sanctions",
  "ca_dfatd_sema_sanctions",
  "ua_nsdc_sanctions",
  "jp_mof_sanctions",
  "be_fod_sanctions",
  "eu_journal_sanctions",
  "us_trade_csl",
] as const;

const TEST_IN_PROGRESS = [
  "ru_mfa_sanctions",
  "tr_fcib",
  "nz_russia_sanctions",
  "fr_tresor_gels_avoir",
];

const TEST_BLOCKED: Record<string, string> = {
  pk_proscribed_persons: "Example: the data URL's TLS certificate has expired.",
  ru_nsd_isin: "Example: the publisher returns HTML instead of the advertised CSV.",
};

/** Countries the remainder of a source is spread over (test only). */
const SPREAD = [
  "ru",
  "ir",
  "cn",
  "kp",
  "sy",
  "by",
  "ae",
  "tr",
  "lb",
  "af",
  "iq",
  "ve",
  "cu",
  "mm",
  "ye",
];

/** FNV-1a → [0, 1): the same input always gives the same number. */
function unit(...parts: string[]) {
  let hash = 0x811c9dc5;
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

let countryCodes: Map<string, string> | undefined;

/** "United States" → "us", from the runtime's own region names. */
function countryCode(name: string | undefined) {
  if (!name) return undefined;
  if (!countryCodes) {
    countryCodes = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        try {
          const label = names.of(code);
          if (label && label !== code) countryCodes.set(label.toLowerCase(), code.toLowerCase());
        } catch {
          // Not a region code.
        }
      }
    }
  }
  return countryCodes.get(name.toLowerCase());
}

const testDay = (...parts: string[]) =>
  new Date(REFERENCE_DAY - Math.floor(unit(...parts) * 60) * 86_400_000).toISOString().slice(0, 19);

/** Split `total` over countries: mostly the issuer's, the rest over a few others. */
function spreadCountries(datasetId: string, total: number, issuer: string | undefined) {
  const counts = new Map<string, number>();
  const add = (code: string, n: number) => n > 0 && counts.set(code, (counts.get(code) ?? 0) + n);
  const unknown = Math.round(total * unit(datasetId, "unknown") * 0.1);
  add(UNKNOWN_COUNTRY, unknown);
  let left = total - unknown;
  if (issuer) {
    const own = Math.round(left * (0.55 + unit(datasetId, "own") * 0.3));
    add(issuer, own);
    left -= own;
  }
  const picks = issuer ? 2 : 4;
  for (let i = 0; i < picks; i += 1) {
    const code = SPREAD[Math.floor(unit(datasetId, "spread", String(i)) * SPREAD.length)]!;
    const n =
      i === picks - 1 ? left : Math.round(left * (0.3 + unit(datasetId, "share", String(i)) * 0.3));
    add(code, n);
    left -= n;
  }
  return counts;
}

function toSide(
  perSource: Array<{ stats: DatasetStats; countries: Map<string, number> }>,
): SideStats {
  const countries = new Map<string, number>();
  const datasetCountries: SideStats["datasetCountries"] = [];
  for (const { stats, countries: split } of perSource) {
    for (const [code, n] of split) {
      countries.set(code, (countries.get(code) ?? 0) + n);
      datasetCountries.push({ d: stats.id, c: code, n });
    }
  }
  return {
    totals: {
      records: perSource.reduce((sum, { stats }) => sum + stats.records, 0),
      entities: perSource.reduce((sum, { stats }) => sum + stats.entities, 0),
      bytes: perSource.reduce((sum, { stats }) => sum + stats.bytes, 0),
    },
    datasets: perSource.map(({ stats }) => stats).sort((a, b) => a.id.localeCompare(b.id)),
    countries: [...countries]
      .map(([code, entities]) => ({ code, entities }))
      .sort((a, b) => b.entities - a.entities),
    datasetCountries,
  };
}

export interface TestData {
  generatedAt: string;
  baseline: SideStats;
  independent: SideStats;
  statuses: Map<string, { workStatus: WorkStatus; blocker?: string }>;
  snapshots: Map<string, { snapshotId: string; importedAt: Date; fetchCompletedAt: Date }>;
  runs: Map<string, IndependentRunDto[]>;
}

let cached: TestData | undefined;

export function testData(): TestData {
  if (cached) return cached;
  const ids = new Set(inventory.sources.map((source) => source.id));

  const feed = inventory.sources.flatMap((source) => {
    const entities = source.inventoryEntities ?? 0;
    if (entities <= 0) return [];
    const records = Math.round(entities * (1.2 + unit(source.id, "records") * 1.8));
    return [
      {
        stats: {
          id: source.id,
          records,
          entities,
          bytes: Math.round(records * (500 + unit(source.id, "bytes") * 900)),
          lastChange: testDay(source.id, "change"),
          lastSeen: testDay(source.id, "seen"),
        },
        countries: spreadCountries(source.id, entities, countryCode(source.issuerCountry)),
      },
    ];
  });
  const feedById = new Map(feed.map((entry) => [entry.stats.id, entry]));

  const imported = Date.parse(TEST_DATA_GENERATED_AT) - 3 * 3_600_000;
  const statuses: TestData["statuses"] = new Map();
  const snapshots: TestData["snapshots"] = new Map();
  const runs: TestData["runs"] = new Map();

  const ours = TEST_SCRAPED_SOURCES.filter((id) => feedById.has(id)).map((id) => {
    const base = feedById.get(id)!;
    const coverage = 0.55 + unit(id, "coverage") * 0.51;
    const countries = new Map<string, number>();
    for (const [code, n] of base.countries) countries.set(code, Math.round(n * coverage));
    const entities = [...countries.values()].reduce((sum, n) => sum + n, 0);
    const records = Math.round(base.stats.records * coverage);
    const snapshotId = "test-2026-11-11";
    statuses.set(id, { workStatus: "validated" });
    snapshots.set(id, {
      snapshotId,
      importedAt: new Date(imported),
      fetchCompletedAt: new Date(imported - 20 * 60_000),
    });
    runs.set(id, [
      {
        id: `${id}-test-import`,
        datasetId: id,
        snapshotId,
        status: "imported",
        adapterVersion: `${id}@test`,
        receivedAt: new Date(imported).toISOString(),
        rows: records,
        errors: [],
      },
    ]);
    return {
      stats: {
        id,
        records,
        entities,
        bytes: Math.round(base.stats.bytes * coverage),
        lastChange: base.stats.lastChange,
      },
      countries,
    };
  });

  // One delivery that was refused before the good one, to show a rejection.
  const refusedFor = TEST_SCRAPED_SOURCES.find((id) => runs.has(id));
  if (refusedFor) {
    runs.get(refusedFor)!.push({
      id: `${refusedFor}-test-rejected`,
      datasetId: refusedFor,
      snapshotId: "test-2026-11-10",
      status: "rejected",
      adapterVersion: `${refusedFor}@test`,
      receivedAt: new Date(imported - 86_400_000).toISOString(),
      errors: ["entities.ftm.jsonl: SHA-256 differs from the manifest (example)"],
    });
  }
  for (const id of TEST_IN_PROGRESS)
    if (ids.has(id)) statuses.set(id, { workStatus: "in_progress" });
  for (const [id, blocker] of Object.entries(TEST_BLOCKED)) {
    if (!ids.has(id)) continue;
    statuses.set(id, { workStatus: "blocked", blocker });
    runs.set(id, [
      {
        id: `${id}-test-failed`,
        datasetId: id,
        snapshotId: "test-2026-11-11",
        status: "failed",
        adapterVersion: `${id}@test`,
        receivedAt: new Date(imported).toISOString(),
        errors: [blocker],
      },
    ]);
  }

  cached = {
    generatedAt: TEST_DATA_GENERATED_AT,
    baseline: toSide(feed),
    independent: toSide(ours),
    statuses,
    snapshots,
    runs,
  };
  return cached;
}
