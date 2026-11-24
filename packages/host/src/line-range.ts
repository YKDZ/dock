export type LineRange = {
  readonly startLine: number;
  readonly endLine: number;
};

export type LineRangeRecord = Readonly<Record<string, LineRange>>;

const recordedLineRanges = new WeakMap<object, LineRange>();

/** Computes 1-based inclusive line numbers for a half-open character range [start, end). */
export function computeLineRange(
  source: string,
  start: number,
  end: number,
): LineRange {
  const startLine = lineNumberAtOffset(source, start);
  if (end <= start) {
    return { startLine, endLine: startLine };
  }
  const endLine = lineNumberAtOffset(source, end - 1);
  return { startLine, endLine };
}

/** Associates a plugin-produced TextRange object with line numbers from its source text without mutating the range. */
export function recordLineRange(
  range: { readonly start: number; readonly end: number },
  source: string,
): void {
  recordedLineRanges.set(
    range,
    computeLineRange(source, range.start, range.end),
  );
}

export function getRecordedLineRange(range: object): LineRange | undefined {
  return recordedLineRanges.get(range);
}

export function lineRangeKey(
  range: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
  },
  referenceId?: string,
): string {
  return `${referenceId ?? ""}\0${range.path}\0${range.start}\0${range.end}`;
}

function lineNumberAtOffset(source: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let index = 0;
  while (index < limit) {
    const code = source.charCodeAt(index);
    if (code === 13 /* \r */) {
      const newlineEnd =
        source.charCodeAt(index + 1) === 10 /* \n */ ? index + 2 : index + 1;
      if (newlineEnd <= limit) {
        line += 1;
      }
      index = newlineEnd;
    } else if (code === 10 /* \n */) {
      line += 1;
      index += 1;
    } else {
      index += 1;
    }
  }
  return line;
}
