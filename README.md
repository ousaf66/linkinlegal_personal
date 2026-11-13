# personal_linkinlegal

Work kept out of the `linkinlegal-mono` repository on purpose.

## sanctions-comparison-dashboard

The internal tool that compares the live sanctions data with what our own scrapers collect, source by source and country by country. It currently runs on test data only.

- **`app/`**: a standalone Vite + React app. It has no API and no database: the figures are generated in `src/comparison/test-data.ts` from the bundled 477-source inventory (`src/comparison/source-inventory.json`).
  - Run it with `pnpm install`, then `pnpm start` (http://localhost:5190).
  - Run the tests with `pnpm test`.
  - The scrapers' delivery format is in `src/comparison/delivery-contract.ts`.
- **`patches/admin-page-version.patch`**: the same dashboard as a hidden, sign-in-only page at `admin.linkinlegal.com/scraper-internal`. It has no menu entry. Apply it in `linkinlegal-mono` with `git apply --3way`.
- **`patches/real-data-server-version.patch`**: the first version, which reads real data. It adds:
  - the scraper collections;
  - the import command for scraper deliveries;
  - the daily count of the live sanctions collection, read from a secondary.

  Use it as the starting point once the scrapers have run.
- **`docs/`**: the handoff plan and the independent-sources plan.

## latest-records-email-automation

The daily "latest sanctions records" email: a cron job, the alert service and model, the email template, the SES worker payload, and tests. It was taken out of the dataset-acronyms PR.

- **`latest-records-email.patch`**: puts it back into `linkinlegal-mono` with `git apply --3way latest-records-email.patch`.
- **`files/`**: the same files in their full form, for reading.

Every patch applies cleanly to `main` as of 13 Nov 2026.
