import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import { comparisonKeys, errorMessage, fetchDetail } from "./api";
import { PairedBars, SideLegend } from "./countries-table";
import {
  CATEGORY_LABEL,
  LINK_CHECK_LABEL,
  SIDES,
  STATUS_LABEL,
  STATUS_TONE,
  countryName,
  fmtBytes,
  fmtDate,
  fmtDay,
  fmtInt,
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

const RUN_TONE = { imported: "green", rejected: "red", failed: "orange" } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Link({ href }: { href?: string }) {
  if (!href) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex max-w-full items-center gap-1 break-all text-primary underline-offset-2 hover:underline"
    >
      {href}
      <ExternalLinkIcon className="size-3 shrink-0" />
    </a>
  );
}

/** One source: both sides' counts, where it comes from, its deliveries and countries. Read-only. */
export function SourceSheet({
  datasetId,
  onClose,
}: {
  datasetId: string | null;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: comparisonKeys.detail(datasetId ?? ""),
    queryFn: () => fetchDetail(datasetId!),
    enabled: !!datasetId,
  });
  const detail = detailQuery.data;
  const max = useMemo(
    () =>
      (detail?.countries ?? []).reduce(
        (top, row) => Math.max(top, row.baseline, row.independent),
        0,
      ),
    [detail],
  );

  return (
    <Sheet open={datasetId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col p-0 data-[side=right]:sm:max-w-2xl!">
        <SheetHeader className="border-b">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <SheetTitle>{detail?.row.title ?? datasetId}</SheetTitle>
            {detail?.row.workStatus ? (
              <StatusChip tone={STATUS_TONE[detail.row.workStatus]}>
                {STATUS_LABEL[detail.row.workStatus]}
              </StatusChip>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{datasetId}</span>
            {detail
              ? ` · ${CATEGORY_LABEL[detail.row.category]}${detail.row.issuerCountry ? ` · issued by ${detail.row.issuerCountry}` : ""}${detail.row.updates ? ` · updates ${detail.row.updates}` : ""}`
              : ""}
          </p>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {detailQuery.isError ? (
            <p className="text-sm text-destructive">{errorMessage(detailQuery.error)}</p>
          ) : !detail ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <>
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                Test data: these figures are examples, not counted from any database.
              </p>

              {detail.row.blocker ? (
                <Section title="Blocker">
                  <p className="text-sm">{detail.row.blocker}</p>
                </Section>
              ) : null}

              <Section title="Counts">
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead />
                        <TableHead className="text-right">{SIDES.baseline.label}</TableHead>
                        <TableHead className="text-right">{SIDES.independent.label}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(
                        [
                          [
                            "Parties",
                            fmtInt(detail.row.baseline?.entities),
                            fmtInt(detail.row.independent?.entities),
                          ],
                          [
                            "Records",
                            fmtInt(detail.row.baseline?.records),
                            fmtInt(detail.row.independent?.records),
                          ],
                          [
                            "Size",
                            fmtBytes(detail.row.baseline?.bytes),
                            fmtBytes(detail.row.independent?.bytes),
                          ],
                          [
                            "Newest change",
                            fmtDay(detail.row.baseline?.lastChange),
                            fmtDay(detail.row.independent?.lastChange),
                          ],
                          [
                            "Last seen / fetched",
                            fmtDay(detail.row.baseline?.lastSeen),
                            fmtDate(detail.row.independent?.fetchedAt),
                          ],
                          ["Imported", "—", fmtDate(detail.row.independent?.importedAt)],
                          ["Snapshot", "—", detail.row.independent?.snapshotId ?? "—"],
                        ] as const
                      ).map(([label, feed, ours]) => (
                        <TableRow key={label}>
                          <TableCell className="text-muted-foreground">{label}</TableCell>
                          <TableCell className="text-right tabular-nums">{feed}</TableCell>
                          <TableCell className="text-right tabular-nums">{ours}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Section>

              {detail.source ? (
                <Section title="Source">
                  <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">Owner</dt>
                    <dd>{detail.source.owner ?? "—"}</dd>
                    <dt className="text-muted-foreground">Publisher page</dt>
                    <dd className="min-w-0">
                      <Link href={detail.source.sourceUrl} />
                    </dd>
                    <dt className="text-muted-foreground">Data</dt>
                    <dd className="min-w-0">
                      <Link href={detail.source.sourceDataUrl} />
                      {detail.source.sourceDataFormat ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {detail.source.sourceDataFormat}
                        </span>
                      ) : null}
                    </dd>
                    <dt className="text-muted-foreground">Link check (10 Nov)</dt>
                    <dd>
                      {detail.source.linkCheck
                        ? (LINK_CHECK_LABEL[detail.source.linkCheck] ?? detail.source.linkCheck)
                        : "—"}
                      <span className="text-muted-foreground">
                        {" "}
                        · a reachable URL is not a working scraper
                      </span>
                    </dd>
                    {detail.source.tags.length ? (
                      <>
                        <dt className="text-muted-foreground">Tags</dt>
                        <dd className="font-mono text-xs">{detail.source.tags.join(", ")}</dd>
                      </>
                    ) : null}
                  </dl>
                </Section>
              ) : null}

              <Section title="Deliveries">
                {detail.runs.length ? (
                  <div className="overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Received</TableHead>
                          <TableHead>Snapshot</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead className="text-right">Records</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.runs.map((run) => (
                          <TableRow key={run.id} className="align-top">
                            <TableCell className="whitespace-nowrap">
                              {fmtDate(run.receivedAt)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{run.snapshotId}</TableCell>
                            <TableCell className="max-w-72 space-y-1">
                              <StatusChip tone={RUN_TONE[run.status]}>{run.status}</StatusChip>
                              {run.errors.length ? (
                                <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                                  {run.errors.slice(0, 5).map((error) => (
                                    <li key={error} className="break-words">
                                      {error}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtInt(run.rows)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No delivery received for this source yet.
                  </p>
                )}
              </Section>

              <Section title="Countries of the parties">
                {detail.countries.length ? (
                  <>
                    <SideLegend />
                    <div className="space-y-2">
                      {detail.countries.slice(0, 15).map((row) => (
                        <div
                          key={row.code}
                          className="grid grid-cols-[9rem_1fr_6.5rem] items-center gap-3 text-sm"
                        >
                          <span className="truncate">{countryName(row.code)}</span>
                          <PairedBars row={row} max={max} />
                          <span className="text-right text-xs text-muted-foreground tabular-nums">
                            {fmtInt(row.baseline)} · {fmtInt(row.independent)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {detail.countries.length > 15 ? (
                      <p className="text-xs text-muted-foreground">
                        and {fmtInt(detail.countries.length - 15)} more countries.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No parties for this source.</p>
                )}
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
