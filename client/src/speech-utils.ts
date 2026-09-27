export function mergeSpeechSegments(segments: string[]): string {
  let merged = "";

  for (const rawSegment of segments) {
    const segment = normalizeSpeech(rawSegment);
    if (!segment) continue;
    if (!merged) {
      merged = segment;
      continue;
    }

    if (segment === merged || merged.endsWith(segment) || merged.startsWith(segment)) continue;
    if (segment.startsWith(merged)) {
      merged = segment;
      continue;
    }

    const overlap = suffixPrefixOverlap(merged, segment);
    merged = overlap > 0
      ? normalizeSpeech(`${merged}${segment.slice(overlap)}`)
      : `${merged} ${segment}`;
  }

  return normalizeSpeech(merged);
}

function suffixPrefixOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let length = max; length > 0; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) return length;
  }
  return 0;
}

function normalizeSpeech(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
