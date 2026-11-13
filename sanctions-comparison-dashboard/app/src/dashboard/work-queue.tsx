import { useMemo } from "react";

import { WORK_STATUSES, type ComparisonDatasetRow, type WorkStatus } from "@/comparison/types";

import { Skeleton } from "@/components/ui/skeleton";

import { STATUS_LABEL, fmtInt } from "./format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CountryQueue = {
  country: string;
  total: number;
  byStatus: Record<WorkStatus, number>;
  done: number;
};

/**
 * The scraper work, by the country that issues each list. Inventory sources only;
 * a row opens the Sources tab narrowed to that country.
 */
export function WorkQueue({
  rows,
  isLoading,
  onPickCountry,
}: {
  rows: ComparisonDatasetRow[];
  isLoading: boolean;
  onPickCountry: (country: string) => void;
}) {
  const queue = useMemo(() => {
    const byCountry = new Map<string, CountryQueue>();
    for (const row of rows) {
      if (!row.inInventory || !row.workStatus) continue;
      const country = row.issuerCountry ?? "Unspecified";
      const entry =
        byCountry.get(country) ??
        ({
          country,
          total: 0,
          done: 0,
          byStatus: Object.fromEntries(WORK_STATUSES.map((status) => [status, 0])),
        } as CountryQueue);
      entry.total += 1;
      entry.byStatus[row.workStatus] += 1;
      if (row.workStatus === "validated" || row.workStatus === "searchable") entry.done += 1;
      byCountry.set(country, entry);
    }
    return [...byCountry.values()].sort(
      (a, b) => b.total - a.total || a.country.localeCompare(b.country),
    );
  }, [rows]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Every inventory source, grouped by the country that issues it, assigned to Abdul Moeed. A
        successful import will move a source to Validated. Open a country to see its sources.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issuer country</TableHead>
              <TableHead className="text-right">Sources</TableHead>
              {WORK_STATUSES.map((status) => (
                <TableHead key={status} className="text-right">
                  {STATUS_LABEL[status]}
                </TableHead>
              ))}
              <TableHead className="text-right">Done</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 8 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={WORK_STATUSES.length + 3}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : queue.map((entry) => (
                  <TableRow
                    key={entry.country}
                    className="cursor-pointer"
                    onClick={() => onPickCountry(entry.country)}
                  >
                    <TableCell className="font-medium">{entry.country}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtInt(entry.total)}</TableCell>
                    {WORK_STATUSES.map((status) => (
                      <TableCell
                        key={status}
                        className={
                          entry.byStatus[status]
                            ? "text-right tabular-nums"
                            : "text-right text-muted-foreground/50 tabular-nums"
                        }
                      >
                        {entry.byStatus[status] || "·"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">
                      {Math.round((entry.done / entry.total) * 100)}%
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
