/**
 * The internal scraper comparison: the sanctions feed we search today (baseline)
 * beside what our own scrapers take from the lists (independent), source by
 * source and country by country. Internal only.
 *
 * For now every figure is TEST DATA built in code: nothing reads, copies or
 * creates a collection. The real sides are wired in after the scrapers run.
 */

export const SOURCE_CATEGORIES = [
  "sanctions",
  "pep",
  "crime",
  "debarment",
  "regulatory",
  "other",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/** Where a source stands in the scraper work. */
export const WORK_STATUSES = [
  "not_started",
  "in_progress",
  "blocked",
  "delivered",
  "validated",
  "searchable",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Where the figures come from. Only "test" exists until the scrapers run. */
export type ComparisonDataSource = "test";

export interface ComparisonSideTotals {
  /** Every record, statements about parties included. */
  records: number;
  /** Parties only: people, companies, vessels and the like. */
  entities: number;
  bytes: number;
  /** Sources with at least one record. */
  datasets: number;
  /** Entity countries with at least one party ("unknown" not counted). */
  countries: number;
}

export interface ComparisonSummaryDto {
  dataSource: ComparisonDataSource;
  generatedAt: string;
  inventory: {
    version: string;
    sources: number;
    byStatus: Record<WorkStatus, number>;
    byCategory: Record<SourceCategory, number>;
  };
  baseline: ComparisonSideTotals;
  independent: ComparisonSideTotals;
}

export interface ComparisonSideCounts {
  records: number;
  entities: number;
  bytes: number;
  /** Newest change among the source's records: content changed, not when it was fetched. */
  lastChange?: string;
}

export interface ComparisonDatasetRow {
  datasetId: string;
  title: string;
  publisher?: string;
  issuerCountry?: string;
  category: SourceCategory;
  /** One of the inventory's sources; false for a source only one side holds. */
  inInventory: boolean;
  updates?: string;
  workStatus?: WorkStatus;
  blocker?: string;
  /** Parties the provider's own catalogue listed for it on the inventory date. */
  inventoryEntities?: number;
  baseline: (ComparisonSideCounts & { lastSeen?: string }) | null;
  independent:
    | (ComparisonSideCounts & {
        snapshotId?: string;
        importedAt?: string;
        fetchedAt?: string;
      })
    | null;
}

export interface ComparisonDatasetsResponse {
  dataSource: ComparisonDataSource;
  generatedAt: string;
  rows: ComparisonDatasetRow[];
}

export interface ComparisonCountryRow {
  /** ISO code in lower case, or "unknown". */
  code: string;
  baseline: number;
  independent: number;
}

export interface ComparisonCountriesResponse {
  dataSource: ComparisonDataSource;
  generatedAt: string;
  /**
   * True for the whole view and for one source. With a category picked, a party on
   * two of its sources counts twice.
   */
  distinct: boolean;
  rows: ComparisonCountryRow[];
}

/** Narrow the countries to one category of sources, or to one source. */
export interface ComparisonCountriesQuery {
  category?: SourceCategory;
  dataset?: string;
}

export type IndependentRunStatus = "imported" | "rejected" | "failed";

/** One scraper delivery and what became of it. */
export interface IndependentRunDto {
  id: string;
  datasetId: string;
  snapshotId: string;
  status: IndependentRunStatus;
  adapterVersion?: string;
  receivedAt: string;
  rows?: number;
  errors: string[];
}

export interface ComparisonDatasetDetail {
  dataSource: ComparisonDataSource;
  generatedAt: string;
  row: ComparisonDatasetRow;
  source: {
    owner?: string;
    sourceUrl?: string;
    sourceDataUrl?: string;
    sourceDataFormat?: string;
    tags: string[];
    /** The 10 Nov 2026 link check of the source data URL: reachability only, not scraper readiness. */
    linkCheck?: string;
  } | null;
  countries: ComparisonCountryRow[];
  runs: IndependentRunDto[];
}
