/**
 * An email job too large for SQS (over 256 KB) arrives as a pointer:
 * `{ template, toEmail, payloadS3Key }`. The API stored the full job in the
 * attachments bucket; this reads it back so it is parsed and rendered like any
 * other. Every other body is returned as it came.
 *
 * A failed read throws: S3 being briefly unavailable is not the job's fault,
 * so the message goes back to the queue and is tried again.
 */
export async function resolveJobBody(
  raw: string,
  readObject: (key: string) => Promise<string>,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // Not JSON: parsing reports it, as before.
  }
  const key = (parsed as { payloadS3Key?: unknown } | null)?.payloadS3Key;
  if (typeof key !== "string" || !key.trim()) return raw;
  return readObject(key);
}
