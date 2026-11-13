import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, DownloadIcon, XIcon } from "lucide-react";

import {
  SOURCE_CATEGORIES,
  WORK_STATUSES,
  type ComparisonDatasetRow,
  type SourceCategory,
  type WorkStatus,
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

import {
  CATEGORY_LABEL,
  SIDES,
  STATUS_LABEL,
  STATUS_TONE,
  coverage,
  fmtAgo,
  fmtDay,
  fmtDelta,
  fmtInt,
  fmtShare,
} from "./format";
import { StatusChip } from "./ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ANY = "all";

/** The filtered rows as a spreadsheet; xlsx loads only when someone exports. */
async function exportToExcel(rows: Array<Record<string, unknown>>, filename: string) {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sources");
  XLSX.writeFile(book, filename);
}
const PAGE_SIZE = 50;

const SHOW_OPTIONS = [
  { value: ANY, label: "All sources" },
  { value: "below", label: "Ours below live" },
  { value: "feed_only", label: "Only in live" },
  { value: "ours_only", label: "Only ours" },
  { value: "outside", label: "Not in the inventory" },
] as const;
type Show = (typeof SHOW_OPTIONS)[number]["value"];

const CATEGORY_OPTIONS = [
  { value: ANY, label: "All categories" },
  ...SOURCE_CATEGORIES.map((category) => ({ value: category, label: CATEGORY_LABEL[category] })),
];

const STATUS_OPTIONS = [
  { value: ANY, label: "Any status" },
  ...WORK_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
];

type SortKey = "title" | "feed" | "ours" | "delta" | "status";

const sortValue = (row: ComparisonDatasetRow, key: SortKey): number | string => {
  switch (key) {
    case "title":
      return row.title.toLowerCase();
    case "feed":
      return row.baseline?.entities ?? -1;
    case "ours":
      return row.independent?.entities ?? -1;
    case "delta":
      return row.independent ? row.independent.entities - (row.baseline?.entities ?? 0) : -Infinity;
    case "status":
      return row.workStatus ? WORK_STATUSES.indexOf(row.workStatus) : -1;
  }
};

function matchesShow(row: ComparisonDatasetRow, show: Show) {
  switch (show) {
    case "below":
      return !!row.independent && row.independent.entities < (row.baseline?.entities ?? 0);
    case "feed_only":
      return !!row.baseline && !row.independent;
    case "ours_only":
      return !!row.independent && !row.baseline;
    case "outside":
      return !row.inInventory;
    default:
      return true;
  }
}

function CoverageBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2" title={`Ours is ${(value * 100).toFixed(1)}% of live`}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", SIDES.independent.swatch)}
          style={{ width: `${Math.min(value, 1) * 100}%` }}
        />
      </div>
      <span className="tabular-nums">{fmtShare(value)}</span>
    </div>
  );
}

function SortHead({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(column)}
      >
        {label}
        {active ? (
          sort.dir === 1 ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

export function SourcesTable({
  rows,
  isLoading,
  isError,
  issuerCountry,
  onClearIssuer,
  onOpen,
}: {
  rows: ComparisonDatasetRow[];
  isLoading: boolean;
  isError: boolean;
  issuerCountry: string | null;
  onClearIssuer: () => void;
  onOpen: (datasetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SourceCategory | typeof ANY>(ANY);
  const [status, setStatus] = useState<WorkStatus | typeof ANY>(ANY);
  const [show, setShow] = useState<Show>(ANY);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "feed", dir: -1 });
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = rows.filter(
      (row) =>
        (category === ANY || row.category === category) &&
        (status === ANY || row.workStatus === status) &&
        (!issuerCountry || (row.issuerCountry ?? "Unspecified") === issuerCountry) &&
        matchesShow(row, show) &&
        (!needle ||
          row.title.toLowerCase().includes(needle) ||
          row.datasetId.includes(needle) ||
          row.publisher?.toLowerCase().includes(needle)),
    );
    return list.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : a.datasetId.localeCompare(b.datasetId)) * sort.dir;
    });
  }, [rows, query, category, status, show, issuerCountry, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const filtering =
    !!query || category !== ANY || status !== ANY || show !== ANY || !!issuerCountry;

  const onSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: key === "title" ? 1 : -1 },
    );
    setPage(0);
  };
  const resetPage =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(0);
    };

  const exportRows = () =>
    void exportToExcel(
      filtered.map((row) => ({
        "Dataset ID": row.datasetId,
        Source: row.title,
        Publisher: row.publisher ?? "",
        "Issuer country": row.issuerCountry ?? "",
        Category: CATEGORY_LABEL[row.category],
        "In inventory": row.inInventory ? "yes" : "no",
        Status: row.workStatus ? STATUS_LABEL[row.workStatus] : "",
        Blocker: row.blocker ?? "",
        "Live parties": row.baseline?.entities ?? "",
        "Live records": row.baseline?.records ?? "",
        "Live last change": row.baseline?.lastChange ?? "",
        "Our parties": row.independent?.entities ?? "",
        "Our records": row.independent?.records ?? "",
        "Our snapshot": row.independent?.snapshotId ?? "",
        "Our import": row.independent?.importedAt ?? "",
        "Inventory listed parties": row.inventoryEntities ?? "",
      })),
      `sanctions-sources-${new Date().toISOString().slice(0, 10)}.xlsx`,
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => resetPage(setQuery)(event.target.value)}
          placeholder="Search source, ID or publisher"
          className="h-8 w-64"
          aria-label="Search sources"
        />
        <Select
          value={category}
          items={CATEGORY_OPTIONS}
          onValueChange={(value) =>
            resetPage(setCategory)((value ?? ANY) as SourceCategory | typeof ANY)
          }
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
        <Select
          value={status}
          items={STATUS_OPTIONS}
          onValueChange={(value) => resetPage(setStatus)((value ?? ANY) as WorkStatus | typeof ANY)}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Filter by work status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={show}
          items={[...SHOW_OPTIONS]}
          onValueChange={(value) => resetPage(setShow)((value ?? ANY) as Show)}
        >
          <SelectTrigger size="sm" className="w-48" aria-label="Which sources to show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHOW_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {issuerCountry ? (
          <Button variant="secondary" size="sm" onClick={onClearIssuer}>
            Issuer: {issuerCountry}
            <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {filtering ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setCategory(ANY);
              setStatus(ANY);
              setShow(ANY);
              onClearIssuer();
              setPage(0);
            }}
          >
            Clear
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {fmtInt(filtered.length)} of {fmtInt(rows.length)} sources
        </span>
        <Button variant="outline" size="sm" onClick={exportRows} disabled={!filtered.length}>
          <DownloadIcon data-icon="inline-start" />
          Export
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Source" column="title" sort={sort} onSort={onSort} />
              <SortHead
                label={SIDES.baseline.parties}
                column="feed"
                sort={sort}
                onSort={onSort}
                className="text-right"
              />
              <SortHead
                label={SIDES.independent.parties}
                column="ours"
                sort={sort}
                onSort={onSort}
                className="text-right"
              />
              <SortHead label="Difference" column="delta" sort={sort} onSort={onSort} />
              <TableHead>Coverage</TableHead>
              <TableHead>Live changed</TableHead>
              <TableHead>Our import</TableHead>
              <SortHead label="Status" column="status" sort={sort} onSort={onSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }, (_, index) => (
                <TableRow key={index}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {isError ? "Could not load the sources." : "No source matches these filters."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => {
                const delta = fmtDelta(row.independent?.entities, row.baseline?.entities);
                return (
                  <TableRow
                    key={row.datasetId}
                    className="cursor-pointer"
                    onClick={() => onOpen(row.datasetId)}
                  >
                    <TableCell className="max-w-80">
                      <div className="truncate font-medium" title={row.title}>
                        {row.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        <span className="font-mono">{row.datasetId}</span>
                        {` · ${CATEGORY_LABEL[row.category]}`}
                        {row.issuerCountry ? ` · ${row.issuerCountry}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtInt(row.baseline?.entities)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtInt(row.independent?.entities)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap tabular-nums",
                        delta.sign < 0 ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {delta.text}
                    </TableCell>
                    <TableCell>
                      <CoverageBar
                        value={coverage(row.independent?.entities, row.baseline?.entities)}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {fmtDay(row.baseline?.lastChange)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {row.independent?.importedAt ? fmtAgo(row.independent.importedAt) : "—"}
                    </TableCell>
                    <TableCell>
                      {row.workStatus ? (
                        <StatusChip tone={STATUS_TONE[row.workStatus]}>
                          {STATUS_LABEL[row.workStatus]}
                        </StatusChip>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not in inventory</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            {fmtInt(current * PAGE_SIZE + 1)}–
            {fmtInt(Math.min((current + 1) * PAGE_SIZE, filtered.length))} of{" "}
            {fmtInt(filtered.length)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
