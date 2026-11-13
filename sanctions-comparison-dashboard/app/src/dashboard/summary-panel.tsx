import {
  WORK_STATUSES,
  type ComparisonSideTotals,
  type ComparisonSummaryDto,
} from "@/comparison/types";

import { Card } from "@/components/ui/card";
import { StatusChip } from "./ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { SIDES, STATUS_LABEL, STATUS_TONE, fmtBytes, fmtInt } from "./format";
import { PANEL_CARD } from "./ui/panel";

type Side = keyof typeof SIDES;

const SIDE_NOTES: Record<Side, string> = {
  baseline: "The sanctions data our search reads today.",
  independent: "What our scrapers take from the publishers' own lists.",
};

function SideCard({ side, totals }: { side: Side; totals: ComparisonSideTotals | null }) {
  const meta = SIDES[side];
  const empty = !totals || totals.records === 0;
  return (
    <Card className={cn(PANEL_CARD, "gap-4")}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("size-2.5 rounded-sm", meta.swatch)} />
        <span className="text-sm font-semibold">{meta.label}</span>
      </div>
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {side === "independent"
            ? "No scraper delivery imported yet. Sources appear here as they are imported."
            : "No records counted yet."}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Parties
            </span>
            <span className="text-3xl font-semibold tabular-nums">{fmtInt(totals.entities)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            {(
              [
                ["Records", fmtInt(totals.records)],
                ["Sources", fmtInt(totals.datasets)],
                ["Countries", fmtInt(totals.countries)],
                ["Size", fmtBytes(totals.bytes)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="text-xs text-muted-foreground">{SIDE_NOTES[side]}</p>
    </Card>
  );
}

function InventoryCard({ inventory }: { inventory: ComparisonSummaryDto["inventory"] }) {
  const done = inventory.byStatus.validated + inventory.byStatus.searchable;
  const share = inventory.sources ? done / inventory.sources : 0;
  return (
    <Card className={cn(PANEL_CARD, "gap-3")}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold">Scraper progress</span>
        <span className="text-xs text-muted-foreground">
          {fmtInt(done)} of {fmtInt(inventory.sources)} inventory sources validated or searchable ·
          inventory of {inventory.version}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={inventory.sources}
        aria-valuenow={done}
        aria-label="Sources validated or searchable"
      >
        <div
          className="h-full rounded-full bg-green-600 dark:bg-green-500"
          style={{ width: `${Math.max(share * 100, done ? 0.5 : 0)}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {WORK_STATUSES.map((status) => (
          <StatusChip key={status} tone={STATUS_TONE[status]}>
            {STATUS_LABEL[status]} · {fmtInt(inventory.byStatus[status])}
          </StatusChip>
        ))}
      </div>
    </Card>
  );
}

export function SummaryPanel({
  summary,
  isLoading,
}: {
  summary: ComparisonSummaryDto | undefined;
  isLoading: boolean;
}) {
  if (isLoading || !summary) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
        <Skeleton className="h-28 lg:col-span-2" />
      </div>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SideCard side="baseline" totals={summary.baseline} />
      <SideCard side="independent" totals={summary.independent} />
      <div className="lg:col-span-2">
        <InventoryCard inventory={summary.inventory} />
      </div>
    </div>
  );
}
