import {
  SOURCE_CATEGORIES,
  WORK_STATUSES,
  type ComparisonCountryRow,
  type ComparisonDatasetRow,
  type ComparisonSideTotals,
  type SourceCategory,
  type WorkStatus,
} from "./types";

/** Parties with no country are counted under this code, so they stay visible. */
export const UNKNOWN_COUNTRY = "unknown";

export interface DatasetStats {
  id: string;
  /** Every record naming the source: parties and the statements about them. */
  records: number;
  /** Parties only (people, companies, vessels…), not Sanction/Address/Ownership rows. */
  entities: number;
  bytes: number;
  lastChange?: string;
  lastSeen?: string;
}

/** Everything the page shows for one side. Built in memory; nothing is stored. */
export interface SideStats {
  totals: { records: number; entities: number; bytes: number };
  datasets: DatasetStats[];
  /** Parties per entity country; a two-country party counts in both. */
  countries: Array<{ code: string; entities: number }>;
  /** Parties per (source, country), for the per-source and per-category views. */
  datasetCountries: Array<{ d: string; c: string; n: number }>;
}

/**
 * The inventory's `list.*` tags, strongest first: a source tagged both sanction
 * and export is a sanctions source. Sector-only tags (health, maritime…) are "other".
 */
const TAG_CATEGORIES: Array<[prefix: string, category: SourceCategory]> = [
  ["list.sanction", "sanctions"],
  ["list.pep", "pep"],
  ["list.wanted", "crime"],
  ["list.terror", "crime"],
  ["list.enforcement", "crime"],
  ["list.debarment", "debarment"],
  ["list.export", "regulatory"],
  ["list.regulatory", "regulatory"],
  ["list.risk", "regulatory"],
];

export function categoryOfTags(tags: readonly string[]): SourceCategory {
  for (const [prefix, category] of TAG_CATEGORIES) {
    if (tags.some((tag) => tag === prefix || tag.startsWith(`${prefix}.`))) return category;
  }
  return "other";
}

export function sideTotals(stats: SideStats | undefined): ComparisonSideTotals | null {
  if (!stats) return null;
  return {
    records: stats.totals.records,
    entities: stats.totals.entities,
    bytes: stats.totals.bytes,
    datasets: stats.datasets.filter((dataset) => dataset.records > 0).length,
    countries: stats.countries.filter((country) => country.code !== UNKNOWN_COUNTRY).length,
  };
}

export const emptyStatusCounts = (): Record<WorkStatus, number> =>
  Object.fromEntries(WORK_STATUSES.map((status) => [status, 0])) as Record<WorkStatus, number>;

export const emptyCategoryCounts = (): Record<SourceCategory, number> =>
  Object.fromEntries(SOURCE_CATEGORIES.map((category) => [category, 0])) as Record<
    SourceCategory,
    number
  >;

export interface RegistryRowInput {
  datasetId: string;
  title: string;
  publisher?: string;
  issuerCountry?: string;
  updates?: string;
  category: SourceCategory;
  workStatus: WorkStatus;
  blocker?: string;
  inventoryEntities?: number;
  independent?: {
    snapshotId: string;
    importedAt: Date;
    fetchCompletedAt?: Date;
  };
}

/**
 * Every source either side knows: all inventory rows (with or without data, so
 * untouched sources stay visible), then any source only the data holds.
 */
export function buildDatasetRows(input: {
  registry: readonly RegistryRowInput[];
  baseline?: SideStats;
  independent?: SideStats;
  /** Titles for sources outside the inventory, from `sanction-dataset-descr`. */
  titles?: ReadonlyMap<string, string>;
}): ComparisonDatasetRow[] {
  const baseline = new Map(input.baseline?.datasets.map((row) => [row.id, row]));
  const independent = new Map(input.independent?.datasets.map((row) => [row.id, row]));
  const rows: ComparisonDatasetRow[] = [];
  const seen = new Set<string>();

  for (const source of input.registry) {
    seen.add(source.datasetId);
    const base = baseline.get(source.datasetId);
    const ours = independent.get(source.datasetId);
    rows.push({
      datasetId: source.datasetId,
      title: source.title,
      ...(source.publisher ? { publisher: source.publisher } : {}),
      ...(source.issuerCountry ? { issuerCountry: source.issuerCountry } : {}),
      ...(source.updates ? { updates: source.updates } : {}),
      category: source.category,
      inInventory: true,
      workStatus: source.workStatus,
      ...(source.blocker ? { blocker: source.blocker } : {}),
      ...(source.inventoryEntities !== undefined
        ? { inventoryEntities: source.inventoryEntities }
        : {}),
      baseline: base ? baselineCounts(base) : null,
      independent: ours
        ? {
            records: ours.records,
            entities: ours.entities,
            bytes: ours.bytes,
            ...(ours.lastChange ? { lastChange: ours.lastChange } : {}),
            ...(source.independent
              ? {
                  snapshotId: source.independent.snapshotId,
                  importedAt: source.independent.importedAt.toISOString(),
                  ...(source.independent.fetchCompletedAt
                    ? { fetchedAt: source.independent.fetchCompletedAt.toISOString() }
                    : {}),
                }
              : {}),
          }
        : null,
    });
  }

  const extras = new Set([...baseline.keys(), ...independent.keys()]);
  for (const datasetId of [...extras].filter((id) => !seen.has(id)).sort()) {
    const base = baseline.get(datasetId);
    const ours = independent.get(datasetId);
    rows.push({
      datasetId,
      title: input.titles?.get(datasetId) ?? datasetId,
      category: "other",
      inInventory: false,
      baseline: base ? baselineCounts(base) : null,
      independent: ours
        ? {
            records: ours.records,
            entities: ours.entities,
            bytes: ours.bytes,
            ...(ours.lastChange ? { lastChange: ours.lastChange } : {}),
          }
        : null,
    });
  }
  return rows;
}

function baselineCounts(row: SideStats["datasets"][number]) {
  return {
    records: row.records,
    entities: row.entities,
    bytes: row.bytes,
    ...(row.lastChange ? { lastChange: row.lastChange } : {}),
    ...(row.lastSeen ? { lastSeen: row.lastSeen } : {}),
  };
}

/**
 * Parties per entity country, both sides.
 *
 * With no sources picked this is the distinct count per country. With sources
 * picked it adds the per-source counts, so a party on two picked sources counts
 * twice — the response says so (`distinct: false`).
 */
export function countryRows(input: {
  baseline?: SideStats;
  independent?: SideStats;
  datasets?: ReadonlySet<string>;
}): { distinct: boolean; rows: ComparisonCountryRow[] } {
  const totals = new Map<string, ComparisonCountryRow>();
  const add = (code: string, side: "baseline" | "independent", n: number) => {
    const row = totals.get(code) ?? { code, baseline: 0, independent: 0 };
    row[side] += n;
    totals.set(code, row);
  };

  for (const side of ["baseline", "independent"] as const) {
    const stats = input[side];
    if (!stats) continue;
    if (input.datasets) {
      for (const pair of stats.datasetCountries) {
        if (input.datasets.has(pair.d)) add(pair.c, side, pair.n);
      }
    } else {
      for (const country of stats.countries) add(country.code, side, country.entities);
    }
  }

  return {
    distinct: !input.datasets || input.datasets.size <= 1,
    rows: [...totals.values()].sort(
      (a, b) => Math.max(b.baseline, b.independent) - Math.max(a.baseline, a.independent),
    ),
  };
}
