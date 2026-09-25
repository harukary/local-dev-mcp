export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function boundedInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : defaultValue;
}

export function structuredTextFallback(value: unknown, options: { max_full_bytes?: number; preview_bytes?: number } = {}): string {
  const serialized = JSON.stringify(value);
  const serializedBytes = Buffer.byteLength(serialized);
  const maxFullBytes = Math.max(256, options.max_full_bytes ?? 4096);
  if (serializedBytes <= maxFullBytes) return serialized;
  const previewBytes = Math.min(maxFullBytes, Math.max(128, options.preview_bytes ?? 1024));
  return JSON.stringify({
    structured_content: true,
    text_fallback_truncated: true,
    serialized_bytes: serializedBytes,
    preview: utf8Prefix(serialized, previewBytes),
  });
}
