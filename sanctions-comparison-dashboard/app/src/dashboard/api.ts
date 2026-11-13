import type { ComparisonCountriesQuery } from "@/comparison/types";
import { getDatasetDetail, getSummary, listCountries, listDatasets } from "@/comparison/service";

/**
 * The dashboard's only way to its figures. Today each read is computed in the
 * browser from the test data; when the tool joins the main app, these become
 * calls to the API and nothing else on the page changes.
 */

export const comparisonKeys = {
  all: ["scraper-internal"] as const,
  summary: () => [...comparisonKeys.all, "summary"] as const,
  datasets: () => [...comparisonKeys.all, "datasets"] as const,
  countries: (query: ComparisonCountriesQuery) =>
    [...comparisonKeys.all, "countries", query] as const,
  detail: (datasetId: string) => [...comparisonKeys.all, "detail", datasetId] as const,
};

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const fetchSummary = async () => getSummary();

export const fetchDatasets = async () => listDatasets();

export const fetchCountries = async (query: ComparisonCountriesQuery) => listCountries(query);

export const fetchDetail = async (datasetId: string) => getDatasetDetail(datasetId);
