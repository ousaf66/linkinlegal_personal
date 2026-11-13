# Sanctions comparison dashboard and scraper handoff

Prepared 11 November 2026. Status: the dashboard (on test data) and delivery contract v1 are on branch `feat/sanctions-comparison-dashboard` (PR to `development`, not released); no collection is read or created yet. The scrapers themselves are Abdul Moeed's.

## Ownership and scope

Abdul Moeed owns source scraping, source-specific parsers, completeness checks, and delivery of normalized snapshots. Our team supplies the data contract, validation/import boundary, comparison calculations, and an internal admin dashboard. We do not build or run scrapers as part of this scope.

This updates the ownership and delivery scope of the earlier [independent ingestion plan](sanctions-independent-sources.md). That document remains background for normalization and evidence requirements; its proposed adapter implementation is Abdul Moeed's responsibility.

For review it is a standalone app, `apps/scraper-internal` (Vite, `pnpm --filter scraper-internal start` → http://localhost:5190), kept out of the web app, the API and admin: no route, link or proxy entry points at it. When it is integrated it becomes a staff-only page. No public website, customer dashboard, customer signup, or separate billing is needed. Server routes must enforce `checkAdmin`, following `admin-analytics.router.ts`; hiding a navigation item is insufficient.

## What staff should see

Two aligned columns compare **OpenSanctions baseline** and **Independent sources**. Label the baseline precisely: it is the provider snapshot actually received by LinkinLegal, not a claim to display the live provider database. Every side shows its snapshot ID, environment, captured-at time, last successful fetch, and last successful import. Compare sources from the same inventory and display snapshot-time differences.

| View                  | Side-by-side values and controls                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary               | Sources in scope, delivered, validated, imported, searchable, blocked and stale; source-record counts; comparable screening-entity counts; raw/normalized bytes.                                                                |
| Source/dataset matrix | Dataset ID and title, publisher and issuer jurisdiction, record category, counts on both sides, delta, snapshot dates, validation/import status, blocker, owner, and adapter version. Include sources present on only one side. |
| Countries             | Entity-country coverage and record counts on both sides, sorted by count or gap. Separate issuer jurisdiction from the countries of the entities in the records. Filters: provider, country, source, category, schema, status.  |
| Source details        | Run history, download/parse/import timings, fetched/accepted/rejected counts, completeness evidence, errors, source links, small paginated record samples, and changes since the previous validated snapshot.                   |
| Work queue            | Unstarted, in progress, blocked, delivered, validated and searchable sources, grouped by country and assigned to Abdul Moeed. Show source progress separately from runtime health.                                              |

Keep all 477 rows from the previously supplied inventory visible, subject to an explicit inventory version. Reconcile against the saved inventory before accepting it as a baseline. New sources require a new inventory version. The earlier link audit's successful HTTP responses are not proof of scraper readiness or a successful import.

### Metric definitions

- **Source records:** distinct `(provider, dataset_id, snapshot_id, source_record_id)` keys after within-source deduplication. Linked `Sanction`, address, occupancy and relationship statements are counted separately from screening entities.
- **Screening entities:** distinct entity IDs within one provider's snapshot and selected category/scope. A `target` flag alone does not prove an active sanction. Separate sanctions, PEP, wanted, debarment, regulatory and reference data.
- **Country counts:** distinct entities per declared entity-country code within the selected scope. Count a multi-country entity once in each relevant country and once in the overall total. Preserve an Unknown group; do not infer nationality from the publisher's country. Country totals need not sum to the overall total.
- **Size:** show bytes and record counts as separate metrics. Neither is a substitute for the other. Do not add counts across overlapping datasets and call the result unique people.
- **Count delta:** independent count minus baseline count, with a percentage only when a nonzero baseline exists. Use Unknown/Unavailable for missing snapshots, and zero only for a validated, complete empty snapshot. Unequal scope or category is marked Not comparable.
- **Overlap/missing entities:** compute only where a verified ID crosswalk exists. Count differences alone do not establish which people are missing, and names alone are insufficient matching evidence. Show unmatched records as unresolved.
- **Freshness:** source publication time, successful fetch time, successful import time, and search-readiness time are distinct. `last_change` means content changed; it is not evidence that a source was fetched recently. Use per-source expected cadence and freshness thresholds.

## Delivery contract for Abdul Moeed

One immutable manifest and normalized JSONL payload per provider/source snapshot. Use the source inventory's stable dataset ID on both sides. The manifest contains:

| Field group    | Required content                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | Contract version, provider (`independent`), dataset ID, run ID, snapshot ID, parser/adapter version, inventory version.                                                                                                             |
| Provenance     | Original publisher and source URLs, issuer jurisdiction, actual source publication time if known, fetch start/completion time, raw snapshot storage key, SHA-256 and byte size. Unknown publication times remain null.              |
| Completeness   | Full snapshot or delta, all expected pages/partitions received, source total if provided, extracted/accepted/rejected/duplicate counts, validation status and evidence. A delta also names its base snapshot and explicit removals. |
| Classification | Sanctions/PEP/other category, entity schemas, country definitions, expected cadence and unresolved limitations.                                                                                                                     |
| Payload        | Normalized JSONL location, SHA-256, bytes, row count, and referenced statement-file locations and hashes when separate.                                                                                                             |
| Failures       | Attempt status and safe error details even when no payload can be delivered. A failure is not an empty successful snapshot.                                                                                                         |

Each normalized record preserves `id`, `caption`, `schema`, `properties` as arrays of strings, `datasets`, `referents`, `target`, `first_seen`, `last_seen`, and `last_change`, matching the existing application contract. Supply a stable publisher/source-record ID and provenance in the source-record store. Identifiers remain strings; preserve leading zeros, aliases, original scripts, partial dates, and linked listing evidence. Independently generated IDs must not masquerade as existing OpenSanctions IDs.

Use linked `schema: "Sanction"` statements with `properties.entity` pointing at the normalized entity ID for authority, reason, measures, source URL, dates, and status. Deliver PEP positions/relationships accurately classified. Ambiguous records remain quarantined or unresolved according to the source's validation contract.

Delivery layout (contract v1, the zod schemas in `packages/types/src/modules/sanctions/comparison.ts`):

```text
independent/<dataset_id>/<snapshot_id>/manifest.json
independent/<dataset_id>/<snapshot_id>/entities.ftm.jsonl
```

Parties and the statements about them (Sanction, Address, Ownership…) go in the same JSONL; a separate statements file is optional and is simply listed as a second file in the manifest. Version 1 accepts full snapshots only. A failed run sends a manifest with `status: "failed"`, an `error`, and no files.

Import (planned for after the scrapers run; not in the PR): it would check every file's SHA-256, bytes and row count against the manifest, validates every record, and rejects duplicate IDs and `NK-` IDs before writing anything; then it writes under the delivery's snapshot ID, makes it current, deletes the source's older rows, moves the source to Validated, and recounts the comparison. Rejected and failed deliveries are recorded with their reasons and change no data. Re-importing a snapshot is idempotent; a delivery fetched before the current snapshot is refused.

## Current state (test data only)

The PR adds only `apps/scraper-internal` (plus its lockfile entry). The dashboard runs in the browser on test data built in code: no API, no database, nothing read, copied or written. The live side uses each source's catalogue count from the supplied 477-source inventory; the scraper side is invented for 12 core sanctions lists. The four reads (`summary`, `datasets`, `countries`, `datasets/:id`) live in `src/comparison/service.ts` behind `src/dashboard/api.ts`; at integration they move behind staff-only API routes and only `api.ts` changes on the page. The delivery contract is `src/comparison/delivery-contract.ts`.

## Delivery order and acceptance

1. **Contract review:** agree on inventory, classifications, IDs, freshness clocks, manifest, normalized fixtures, and one successful plus one failed delivery with Abdul Moeed. No live crawl is needed from our team.
2. **Comparison foundation:** validate/import the two providers' snapshots in staging and generate repeatable summaries. Replaying a snapshot is idempotent. Reject partial/invalid snapshots without altering the current valid comparison.
3. **Internal dashboard:** implement summary, source matrix, country comparison, details/run history, filters and CSV export. Verify non-admin requests are refused at the API and all views use one comparison ID.
4. **Source rollout:** Abdul Moeed supplies sources in batches, beginning with core sanctions. Track every inventory row; blocked and not-started sources stay visible. Do not describe the first batch as complete coverage.
5. **Acceptance:** manually reconcile representative sources and country counts against saved payloads; verify classification, overlap, unknown countries, multi-country entities, no-baseline cases, failed refreshes, stale sources, and snapshot-time mismatch. Test replay, explicit removal, no accidental delisting on failure, and bounded page-load cost on representative data volumes. Set performance targets from measured staging results.

## Current report and production-loading follow-up

The screenshot shows unresolved provider citation IDs. The client now removes these opaque tokens from report display and Word export and explicitly flags missing references. It preserves valid numbered URL links and the available source list. It cannot recover a source mapping that was never saved. The Python report service is a separate repository (`sanction/api-sanction-pep-search`); its `openai_report` function resolves annotated citation spans. Inspect a failing response plus the stored report's source metadata there to repair future generation and determine whether an existing report can be regenerated with verified citations. Do not invent a mapping from `search8` to the ninth URL.

The latest table previously called the general `/sanctions-pep` search, which awaits an exact matching-record count along with its rows. The new `/sanctions-pep/latest` endpoint uses the same scope, indexed date order and listing-status enrichment without the count. Selecting a specific source also avoids reading the default source inventory. General search/export pagination retains its totals.

The follow-up [read-only production diagnosis](../work/sanctions-production-latency-audit/diagnosis.md) reproduced the default view's blocking sort, verified the revised date-index plan, and found missing generated search fields on recent production records. The latest route now uses the date index for its broad implicit scope; the existing search-field refresh is scheduled every 15 minutes locally instead of daily. These changes are not deployed. Before claiming the production issue resolved:

- The user confirmed both page loading and delayed arrivals. The latest endpoint addresses page loading, and the refresh cadence addresses the confirmed delay in generating search fields. Upstream publication-to-import delay still needs the external loader's logs.
- Compare the deployed server/client revisions and routes in Dev and Production; deploy the server route before the client starts using it.
- Read the production query plans/index inventory for the actual selected/default dataset scope. Verify the hinted `active_dataset_lastChange` / `active_lastChange` indexes, statement lookup (`statement_by_entity`), entity-ID lookup, and listing-status lookup are usable. Schema declarations and a development database do not prove production index readiness.
- Measure authenticated end-to-end and query timings with cold and warm caches and representative filters; distinguish source-scope reads, row retrieval, listing enrichment, network and rendering. Preserve listing status rather than removing it to improve timings.
- If records arrive late, inspect the external loader's schedule, last successful source download/import, failed runs, per-source age, derived search-field refresh, and metadata refresh. The loader is not implemented in this monorepo. Compare publication, download, import and searchable times rather than using `last_change` as an ingestion clock.

No scraper, ingestion job, database migration, production deployment or external message was executed as part of this handoff.
