import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, FlaskConicalIcon } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { comparisonKeys, errorMessage, fetchDatasets, fetchSummary } from "./api";
import { CountriesTable } from "./countries-table";
import { fmtDate } from "./format";
import { SourceSheet } from "./source-sheet";
import { SourcesTable } from "./sources-table";
import { SummaryPanel } from "./summary-panel";
import { WorkQueue } from "./work-queue";

type Tab = "sources" | "countries" | "queue";

function Notice({
  tone = "neutral",
  icon,
  title,
  children,
}: {
  tone?: "neutral" | "danger";
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "danger" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40",
      )}
    >
      {icon ?? (
        <AlertTriangleIcon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            tone === "danger" ? "text-destructive" : "text-muted-foreground",
          )}
        />
      )}
      <div className="space-y-0.5">
        <p className="font-medium">{title}</p>
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * The sanctions feed we search today beside what our own scrapers take from the
 * lists, source by source and country by country. Test data until the scrapers
 * run: the API reads, copies and creates no collection.
 */
function ComparisonDashboard() {
  const [tab, setTab] = useState<Tab>("sources");
  const [issuer, setIssuer] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const summaryQuery = useQuery({ queryKey: comparisonKeys.summary(), queryFn: fetchSummary });
  const datasetsQuery = useQuery({ queryKey: comparisonKeys.datasets(), queryFn: fetchDatasets });
  const summary = summaryQuery.data;
  const rows = datasetsQuery.data?.rows ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Sanctions comparison</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The sanctions feed we search today beside what our own scrapers take from the lists: how
          many parties each holds, source by source and country by country.
        </p>
      </div>

      <Notice
        icon={<FlaskConicalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        title="Test data"
      >
        Every number on this page is an example, generated in code
        {summary ? ` (${fmtDate(summary.generatedAt)})` : ""}. This app has no API and no database
        behind it: nothing is read, copied or written. The feed side uses each source&rsquo;s
        catalogue count from the inventory; the scraper side is invented for 12 core sanctions
        lists. Real figures replace these after the scrapers run.
      </Notice>

      {summaryQuery.isError ? (
        <Notice tone="danger" title="Could not load the comparison">
          {errorMessage(summaryQuery.error)}
        </Notice>
      ) : (
        <SummaryPanel summary={summary} isLoading={summaryQuery.isLoading} />
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line">
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="countries">Countries</TabsTrigger>
          <TabsTrigger value="queue">Work queue</TabsTrigger>
        </TabsList>
        <TabsContent value="sources" className="pt-3">
          <SourcesTable
            rows={rows}
            isLoading={datasetsQuery.isLoading}
            isError={datasetsQuery.isError}
            issuerCountry={issuer}
            onClearIssuer={() => setIssuer(null)}
            onOpen={setSelected}
          />
        </TabsContent>
        <TabsContent value="countries" className="pt-3">
          <CountriesTable datasets={rows} />
        </TabsContent>
        <TabsContent value="queue" className="pt-3">
          <WorkQueue
            rows={rows}
            isLoading={datasetsQuery.isLoading}
            onPickCountry={(country) => {
              setIssuer(country);
              setTab("sources");
            }}
          />
        </TabsContent>
      </Tabs>

      <SourceSheet datasetId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/**
 * A standalone app, kept out of the LinkinLegal app until it has been reviewed.
 * It runs on test data only, so it has no sign-in yet: staff-only access comes
 * with the move into the main app, alongside the real figures.
 */
export function ScraperInternalPage() {
  return (
    <div className="min-h-svh bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4">
          <span className="font-semibold">LinkinLegal</span>
          <span className="text-sm text-muted-foreground">Scraper internal</span>
          <span className="ml-auto text-xs text-muted-foreground">Standalone preview</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6">
        <ComparisonDashboard />
      </main>
    </div>
  );
}
