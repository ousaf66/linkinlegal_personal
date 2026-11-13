import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Delivery contract, version 1: what a scraper hands over per source. */
/* ------------------------------------------------------------------ */

const isoDateTime = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

/** A payload file, named relative to the manifest; no absolute paths, no `..`. */
const payloadFile = z.object({
  path: z.string().regex(/^[A-Za-z0-9_.-]+\.jsonl$/, "a .jsonl file name beside manifest.json"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "lower-case hex SHA-256"),
  bytes: count,
  rows: count,
});

/**
 * `manifest.json`, one per source per run, beside its JSONL files:
 *
 *     independent/<datasetId>/<snapshotId>/manifest.json
 *     independent/<datasetId>/<snapshotId>/entities.ftm.jsonl
 *
 * A run that could not produce data still sends a manifest with `status: "failed"`
 * and no files: a failure is recorded, never read as an empty source. Version 1
 * takes full snapshots only; every success replaces the source's previous one.
 */
export const independentManifestSchema = z
  .object({
    contractVersion: z.literal(1),
    provider: z.literal("independent"),
    /** The inventory's dataset ID, e.g. `us_ofac_sdn`. */
    datasetId: z.string().regex(/^[a-z0-9_]{1,120}$/),
    /** Unique per run of the source, e.g. `2026-11-12T0400Z`. Re-sending one is a replay. */
    snapshotId: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    runId: z.string().max(200).optional(),
    adapterVersion: z.string().min(1).max(100),
    inventoryVersion: z.string().max(50).optional(),
    status: z.enum(["success", "failed"]),
    error: z.string().max(4000).optional(),
    sourceUrls: z.array(z.url()).max(50).default([]),
    /** When the publisher says it published this version; null when it does not say. */
    publishedAt: isoDateTime.nullable().default(null),
    fetchStartedAt: isoDateTime,
    fetchCompletedAt: isoDateTime.optional(),
    /** Every page/partition of the source was received. */
    complete: z.boolean(),
    /** The record total the publisher states, when it states one. */
    sourceTotal: count.nullable().default(null),
    counts: z.object({
      extracted: count,
      accepted: count,
      rejected: count,
      duplicates: count,
    }),
    files: z.array(payloadFile).max(20).default([]),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.status === "failed") {
      if (!manifest.error)
        ctx.addIssue({ code: "custom", path: ["error"], message: "say why it failed" });
      return;
    }
    if (!manifest.complete) {
      ctx.addIssue({
        code: "custom",
        path: ["complete"],
        message: "contract v1 accepts complete snapshots only",
      });
    }
    if (!manifest.fetchCompletedAt) {
      ctx.addIssue({ code: "custom", path: ["fetchCompletedAt"], message: "required on success" });
    }
    if (manifest.files.length === 0) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "a success needs a payload file" });
    }
    const rows = manifest.files.reduce((sum, file) => sum + file.rows, 0);
    if (rows !== manifest.counts.accepted) {
      ctx.addIssue({
        code: "custom",
        path: ["counts", "accepted"],
        message: `accepted (${manifest.counts.accepted}) must equal the files' rows (${rows})`,
      });
    }
    if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "a file is listed twice" });
    }
  });
export type IndependentManifest = z.infer<typeof independentManifestSchema>;

const ftmDate = z.string().max(40);

/**
 * One line of a payload file: a FollowTheMoney entity, the shape `sanctions-data`
 * already holds. Parties (Person, Company, Vessel…) and the statements about them
 * (Sanction, Address, Ownership…) go in the same file; a Sanction points at its
 * party through `properties.entity`.
 */
export const independentRecordSchema = z.object({
  /** Stable across runs of the same source, and never a provider's `NK-` ID. */
  id: z
    .string()
    .min(1)
    .max(300)
    .refine((id) => !/^NK-/i.test(id), "an NK- ID belongs to the provider; mint our own"),
  caption: z.string().max(5000).default(""),
  schema: z.string().regex(/^[A-Z][A-Za-z]{1,60}$/, "a FollowTheMoney schema name"),
  properties: z.record(z.string().max(100), z.array(z.string().max(20_000)).max(5000)),
  datasets: z.array(z.string().max(120)).max(50).optional(),
  referents: z.array(z.string().max(300)).max(500).optional(),
  target: z.boolean().optional(),
  first_seen: ftmDate.optional(),
  last_seen: ftmDate.optional(),
  last_change: ftmDate.optional(),
});
export type IndependentRecord = z.infer<typeof independentRecordSchema>;
