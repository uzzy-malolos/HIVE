/** Grapheme boundaries stay UTF-16 offsets so they compose with String.slice. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function* graphemes(input: string): Iterable<string> {
  for (const part of segmenter.segment(input)) yield part.segment;
}

export function graphemeCursor(input: string, offset: number): number {
  const bounded = Math.max(0, Math.min(input.length, Math.floor(offset)));
  if (bounded === input.length) return bounded;
  let previous = 0;
  for (const part of segmenter.segment(input)) {
    if (part.index > bounded) break;
    previous = part.index;
  }
  return previous;
}

export function moveGraphemeCursor(input: string, offset: number, delta: number): number {
  const positions = [...segmenter.segment(input)].map((part) => part.index);
  positions.push(input.length);
  const cursor = graphemeCursor(input, offset);
  const current = positions.indexOf(cursor);
  return positions[Math.max(0, Math.min(positions.length - 1, current + delta))];
}

export function graphemeColumnOffset(input: string, column: number): number {
  let remaining = column;
  for (const part of segmenter.segment(input)) {
    if (remaining <= 0) return part.index;
    remaining -= 1;
  }
  return input.length;
}

/** Readline word motion uses whitespace boundaries, preserving paths and flags. */
export function moveWordCursor(input: string, offset: number, direction: -1 | 1): number {
  const cursor = graphemeCursor(input, offset);
  if (direction < 0) {
    const before = input.slice(0, cursor);
    return graphemeCursor(input, before.replace(/\s+$/u, "").replace(/\S+$/u, "").length);
  }
  const after = input.slice(cursor);
  const word = /^\s*\S+/u.exec(after);
  return word ? cursor + word[0].length : input.length;
}
