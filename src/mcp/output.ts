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
