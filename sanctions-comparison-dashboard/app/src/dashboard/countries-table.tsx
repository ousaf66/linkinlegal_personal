import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  SOURCE_CATEGORIES,
  type ComparisonCountryRow,
  type ComparisonDatasetRow,
  type SourceCategory,
} from "@/comparison/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { comparisonKeys, fetchCountries } from "./api";
import { CATEGORY_LABEL, SIDES, countryName, coverage, fmtDelta, fmtInt, fmtShare } from "./format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ANY = "all";
const SHOWN = 100;

const CATEGORY_OPTIONS = [
  { value: ANY, label: "All categories" },
  ...SOURCE_CATEGORIES.map((category) => ({ value: category, label: CATEGORY_LABEL[category] })),
];

const SORTS = [
  { value: "size", label: "Most parties" },
  { value: "gap", label: "Biggest shortfall" },
  { value: "name", label: "Country name" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

export function SideLegend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      {(["baseline", "independent"] as const).map((side) => (
        <span key={side} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2.5 rounded-sm", SIDES[side].swatch)} />
          {SIDES[side].label}
        </span>
      ))}
    </div>
  );
}

/** Two thin bars on one shared scale, so rows compare with each other as well as side to side. */
export function PairedBars({ row, max }: { row: ComparisonCountryRow; max: number }) {
  const width = (value: number) => `${max ? Math.max((value / max) * 100, value ? 1 : 0) : 0}%`;
  return (
    <div
      className="flex w-full min-w-40 flex-col gap-0.5"
      title={`${countryName(row.code)}: live ${fmtInt(row.baseline)} · ours ${fmtInt(row.independent)}`}
    >
      <div className="h-2 overflow-hidden">
        <div
          className={cn("h-full rounded-r-[4px]", SIDES.baseline.swatch)}
          style={{ width: width(row.baseline) }}
        />
      </div>
      <div className="h-2 overflow-hidden">
        <div
          className={cn("h-full rounded-r-[4px]", SIDES.independent.swatch)}
          style={{ width: width(row.independent) }}
        />
      </div>
    </div>
  );
}

export function CountriesTable({ datasets }: { datasets: ComparisonDatasetRow[] }) {
  const [category, setCategory] = useState<SourceCategory | typeof ANY>(ANY);
  const [dataset, setDataset] = useState("");
  const [sort, setSort] = useState<Sort>("size");
  const [needle, setNeedle] = useState("");
  const [showAll, setShowAll] = useState(false);

  const datasetOptions = useMemo(
    () =>
      datasets
        .filter((row) => row.baseline || row.independent)
        .map((row) => row.datasetId)
        .sort(),
    [datasets],
  );
  const picked = datasetOptions.includes(dataset) ? dataset : "";
  const query = useMemo(
    () => (picked ? { dataset: picked } : category !== ANY ? { category } : {}),
    [picked, category],
  );
  const countriesQuery = useQuery({
    queryKey: comparisonKeys.countries(query),
    queryFn: () => fetchCountries(query),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    const list = (countriesQuery.data?.rows ?? []).filter(
      (row) =>
        !needle.trim() ||
        countryName(row.code).toLowerCase().includes(needle.trim().toLowerCase()) ||
        row.code.includes(needle.trim().toLowerCase()),
    );
    const sorted = [...list];
    if (sort === "name")
      sorted.sort((a, b) => countryName(a.code).localeCompare(countryName(b.code)));
    else if (sort === "gap")
      sorted.sort((a, b) => b.baseline - b.independent - (a.baseline - a.independent));
    else
      sorted.sort(
        (a, b) => Math.max(b.baseline, b.independent) - Math.max(a.baseline, a.independent),
      );
    return sorted;
  }, [countriesQuery.data, needle, sort]);

  const max = useMemo(
    () => rows.reduce((top, row) => Math.max(top, row.baseline, row.independent), 0),
    [rows],
  );
  const visible = showAll ? rows : rows.slice(0, SHOWN);
  const data = countriesQuery.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
          placeholder="Find a country"
          className="h-8 w-48"
          aria-label="Find a country"
        />
        <Select
          value={category}
          items={CATEGORY_OPTIONS}
          onValueChange={(value) => {
            setCategory((value ?? ANY) as SourceCategory | typeof ANY);
            setDataset("");
          }}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="Filter by category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={dataset}
          onChange={(event) => {
            const value = event.target.value.trim();
            setDataset(value);
            if (value) setCategory(ANY);
          }}
          list="scraper-internal-sources"
          placeholder="One source ID…"
          className="h-8 w-56"
          aria-label="Narrow to one source"
        />
        <datalist id="scraper-internal-sources">
          {datasetOptions.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <Select
          value={sort}
          items={[...SORTS]}
          onValueChange={(value) => setSort((value ?? "size") as Sort)}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="Sort countries">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <SideLegend />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Parties per country of the party (nationality, registration, flag), not the country that
        issued the list. A party with two countries counts in both; parties with none are “Unknown”.
        {data && !data.distinct
          ? " With several sources picked, a party on two of them counts twice."
          : ""}
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Country</TableHead>
              <TableHead className="text-right">{SIDES.baseline.parties}</TableHead>
              <TableHead className="text-right">{SIDES.independent.parties}</TableHead>
              <TableHead>Difference</TableHead>
              <TableHead className="text-right">Coverage</TableHead>
              <TableHead className="w-1/3">Side by side</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {countriesQuery.isLoading ? (
              Array.from({ length: 8 }, (_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {countriesQuery.isError
                    ? "Could not load the countries."
                    : "No parties for this selection."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => {
                const share = coverage(row.independent, row.baseline);
                return (
                  <TableRow key={row.code}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {countryName(row.code)}
                      {row.code !== "unknown" ? (
                        <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                          {row.code}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtInt(row.baseline)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtInt(row.independent)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {fmtDelta(row.independent, row.baseline).text}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {fmtShare(share)}
                    </TableCell>
                    <TableCell>
                      <PairedBars row={row} max={max} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > SHOWN ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll ? `Show the top ${SHOWN}` : `Show all ${fmtInt(rows.length)} countries`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
