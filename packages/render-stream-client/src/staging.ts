/** Staging work, in milliseconds; maxima are per payload, excluding yielded time.
 * bytesOut counts decoded residency bytes, using the core's payload-store accounting. */
export interface StagingSample {
  /** The hash implementation that supplied this payload's digest. */
  digestPath?: DigestPath;
  copyMs: number;
  commitMs: number;
  finishMs: number;
  workerMessageMs: number;
  /** Worker hash work; JS excludes reads, native includes the async digest wait. */
  workerHashMs: number;
  sliceMs: number;
  bytesIn: number;
  bytesOut: number;
}
export type DigestPath = "native" | "js-incremental" | "wasm";
const metrics = [
  "copyMs",
  "commitMs",
  "finishMs",
  "workerMessageMs",
  "workerHashMs",
  "sliceMs",
  "bytesIn",
  "bytesOut",
] as const;
export type StagingKind =
  | "rgba8Texture"
  | "otherTexture"
  | "mesh"
  | "shader"
  | "other";
export type StagingTotals = {
  payloads: number;
  nativePayloads: number;
  jsIncrementalPayloads: number;
  wasmPayloads: number;
  nativeHashMsSum: number;
  nativeHashMsMax: number;
  jsIncrementalHashMsSum: number;
  jsIncrementalHashMsMax: number;
} & {
  [K in (typeof metrics)[number] as `${K}Sum` | `${K}Max`]: number;
};
export type StagingStats = Record<StagingKind, StagingTotals>;

export function stagingSample(): StagingSample {
  return {
    copyMs: 0,
    commitMs: 0,
    finishMs: 0,
    workerMessageMs: 0,
    workerHashMs: 0,
    sliceMs: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
}

export class StagingCounters {
  private readonly totals = Object.fromEntries(
    ["rgba8Texture", "otherTexture", "mesh", "shader", "other"].map((kind) => {
      const row: Record<string, number> = {
        payloads: 0,
        nativePayloads: 0,
        jsIncrementalPayloads: 0,
        wasmPayloads: 0,
        nativeHashMsSum: 0,
        nativeHashMsMax: 0,
        jsIncrementalHashMsSum: 0,
        jsIncrementalHashMsMax: 0,
      };
      for (const key of metrics) {
        row[`${key}Sum`] = 0;
        row[`${key}Max`] = 0;
      }
      return [kind, row];
    }),
  ) as StagingStats;

  record(kind: StagingKind, sample: StagingSample): void {
    const row = this.totals[kind];
    row.payloads++;
    if (sample.digestPath === "native") row.nativePayloads++;
    else if (sample.digestPath === "js-incremental")
      row.jsIncrementalPayloads++;
    else row.wasmPayloads++;
    const path =
      sample.digestPath === "native"
        ? "native"
        : sample.digestPath === "js-incremental"
          ? "jsIncremental"
          : null;
    if (path) {
      row[`${path}HashMsSum`] += sample.workerHashMs;
      row[`${path}HashMsMax`] = Math.max(
        row[`${path}HashMsMax`],
        sample.workerHashMs,
      );
    }
    for (const key of metrics) {
      row[`${key}Sum`] += sample[key];
      row[`${key}Max`] = Math.max(row[`${key}Max`], sample[key]);
    }
  }

  snapshot(): StagingStats {
    return Object.fromEntries(
      Object.entries(this.totals).map(([k, v]) => [k, { ...v }]),
    ) as StagingStats;
  }
}
