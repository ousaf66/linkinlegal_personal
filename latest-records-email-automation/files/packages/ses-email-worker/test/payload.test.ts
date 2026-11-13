import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveJobBody } from "../src/payload";

const full = JSON.stringify({
  template: "sanction-latest-records",
  toEmail: "a@example.com",
  rows: ["…"],
});

test("an inline job is used as it came", async () => {
  const read = async () => assert.fail("must not read S3");
  assert.equal(await resolveJobBody(full, read), full);
  assert.equal(await resolveJobBody("not json", read), "not json");
});

test("a job stored in S3 is read back by its key", async () => {
  const pointer = JSON.stringify({
    template: "sanction-latest-records",
    toEmail: "a@example.com",
    payloadS3Key: "email-payloads/2026-11-13/x.json",
  });
  const keys: string[] = [];
  const body = await resolveJobBody(pointer, async (key) => {
    keys.push(key);
    return full;
  });
  assert.equal(body, full);
  assert.deepEqual(keys, ["email-payloads/2026-11-13/x.json"]);
});

test("a failed read is thrown, so the message is retried", async () => {
  const pointer = JSON.stringify({ template: "t", toEmail: "a@example.com", payloadS3Key: "k" });
  await assert.rejects(
    resolveJobBody(pointer, async () => {
      throw new Error("S3 unavailable");
    }),
    /S3 unavailable/,
  );
});
