import type {
  ComparisonCountriesQuery,
  ComparisonCountriesResponse,
  ComparisonDatasetDetail,
  ComparisonDatasetsResponse,
  ComparisonSummaryDto,
} from "./types";

import {
  buildDatasetRows,
  categoryOfTags,
  countryRows,
  emptyCategoryCounts,
  emptyStatusCounts,
  sideTotals,
  type RegistryRowInput,
} from "./compute";
import { testData } from "./test-data";
import inventory from "./source-inventory.json";

/**
 * The scraper comparison's reads, computed in the browser from TEST DATA: there
 * is no API and no database behind this app. When the tool joins the main app,
 * these same four reads move behind staff-only API routes, the live side from
 * the sanctions search collection and the scraper side from the scrapers' own.
 */

export const INVENTORY_VERSION = inventory.version;
export const SCRAPER_OWNER = "Abdul Moeed";

type InventorySource = (typeof inventory.sources)[number] & Record<string, unknown>;

const sources = inventory.sources as InventorySource[];

function registryRows(): RegistryRowInput[] {
  const data = testData();
  return sources.map((source) => {
    const status = data.statuses.get(source.id);
    const snapshot = data.snapshots.get(source.id);
    return {
      datasetId: source.id,
      title: source.title,
      ...(source.publisher ? { publisher: source.publisher } : {}),
      ...(source.issuerCountry ? { issuerCountry: source.issuerCountry } : {}),
      ...(source.updates ? { updates: source.updates } : {}),
      category: categoryOfTags(source.tags),
      workStatus: status?.workStatus ?? "not_started",
      ...(status?.blocker ? { blocker: status.blocker } : {}),
      ...(source.inventoryEntities !== undefined
        ? { inventoryEntities: source.inventoryEntities }
        : {}),
      ...(snapshot ? { independent: snapshot } : {}),
    };
  });
}

const datasetRows = () => {
  const data = testData();
  return buildDatasetRows({
    registry: registryRows(),
    baseline: data.baseline,
    independent: data.independent,
  });
};

export function getSummary(): ComparisonSummaryDto {
  const data = testData();
  const byStatus = emptyStatusCounts();
  const byCategory = emptyCategoryCounts();
  for (const row of registryRows()) {
    byStatus[row.workStatus] += 1;
    byCategory[row.category] += 1;
  }
  return {
    dataSource: "test",
    generatedAt: data.generatedAt,
    inventory: { version: INVENTORY_VERSION, sources: sources.length, byStatus, byCategory },
    baseline: sideTotals(data.baseline)!,
    independent: sideTotals(data.independent)!,
  };
}

export function listDatasets(): ComparisonDatasetsResponse {
  return { dataSource: "test", generatedAt: testData().generatedAt, rows: datasetRows() };
}

export function listCountries(query: ComparisonCountriesQuery): ComparisonCountriesResponse {
  const data = testData();
  let datasets: Set<string> | undefined;
  if (query.dataset) datasets = new Set([query.dataset]);
  else if (query.category) {
    datasets = new Set(
      datasetRows()
        .filter((row) => row.category === query.category)
        .map((row) => row.datasetId),
    );
  }
  return {
    dataSource: "test",
    generatedAt: data.generatedAt,
    ...countryRows({ baseline: data.baseline, independent: data.independent, datasets }),
  };
}

export function getDatasetDetail(datasetId: string): ComparisonDatasetDetail {
  const data = testData();
  const row = datasetRows().find((candidate) => candidate.datasetId === datasetId);
  if (!row) throw new Error(`No source ${datasetId} in the inventory`);
  const source = sources.find((candidate) => candidate.id === datasetId);
  return {
    dataSource: "test",
    generatedAt: data.generatedAt,
    row,
    source: source
      ? {
          owner: SCRAPER_OWNER,
          ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
          ...(source.sourceDataUrl ? { sourceDataUrl: source.sourceDataUrl } : {}),
          ...(source.sourceDataFormat ? { sourceDataFormat: source.sourceDataFormat } : {}),
          tags: source.tags ?? [],
          ...(source.linkCheck ? { linkCheck: source.linkCheck } : {}),
        }
      : null,
    countries: countryRows({
      baseline: data.baseline,
      independent: data.independent,
      datasets: new Set([datasetId]),
    }).rows,
    runs: [...(data.runs.get(datasetId) ?? [])].sort((a, b) =>
      b.receivedAt.localeCompare(a.receivedAt),
    ),
  };
}
