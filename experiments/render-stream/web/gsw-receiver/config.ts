// GSW receiver configuration (gate7-design.md Q5, G7a): the native receiver's RS_RECEIVER_* names,
// read from the page URL. The harness maps a native leg's env.txt to this page exactly as it maps
// one for the web export (scripts/lib/gate7-web-legs.ts mapNativeLeg): `?env=<base64url JSON>` of
// `{env: {RS_RECEIVER_*: value}, canvas: [w, h], sabotage: "css-opacity" | null}`. Paths are
// same-origin URL paths. Nothing here is render-stream state; it is only what to read and where to
// write.

export type ReceiverMode = "file" | "live";

export interface ReceiverConfig {
  mode: ReceiverMode;
  /** URL path of the recording (file mode). */
  recording: string;
  /** URL path of applied.json; shots go to <dirname>/shots/, state dumps to <dirname>/state/. */
  out: string;
  shotSeqs: number[];
  stateSeqs: number[];
  /** URL path of the capture's store (`sha256/<hash>.<grt|grm|grp>`), or null. */
  store: string | null;
  /** RS_RECEIVER_CACHE_MODE as given (the browser's HTTP cache stands in for a cache directory). */
  cacheMode: string | null;
  shaderLibrary: string | null;
  fetchDelayMs: number;
  /** RS_RECEIVER_SABOTAGE, split on commas. */
  sabotage: string[];
  log: "full" | "summary";
  perfOut: string | null;
  memoryBudgetBytes: number | null;
  cacheBudgetBytes: number | null;
  buildSha256: string | null;
  manifestSha256: string | null;
  /** RS_RECEIVER_EVIDENCE_URL: `PUT <url>/<path relative to dirname(out)>`. */
  evidenceUrl: string;
  /** The harness's own sabotage (Q7 `css-opacity`): the shell's, not the receiver's. */
  shellSabotage: string | null;
  canvas: [number, number] | null;
  /** Every RS_RECEIVER_* value as given, for the log. */
  raw: Record<string, string>;
}

export class UsageError extends Error {}

function decodeBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function seqList(name: string, value: string | undefined): number[] {
  if (value === undefined || value.trim() === "") return [];
  const out: number[] = [];
  for (const part of value.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1)
      throw new UsageError(`${name}: "${part}" is not a seq >= 1`);
    out.push(n);
  }
  return out;
}

function nonNegative(name: string, value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new UsageError(`${name}: "${value}" is not a non-negative integer`);
  return n;
}

function orNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

/** Parses `location.search`. Throws UsageError (the native receiver's exit 2) when malformed. */
export function readConfig(search: string): ReceiverConfig {
  const q = new URLSearchParams(search);
  const encoded = q.get("env");
  if (!encoded) throw new UsageError("no ?env= configuration");
  const page = JSON.parse(decodeBase64Url(encoded)) as {
    env?: Record<string, string>;
    canvas?: [number, number];
    sabotage?: string | null;
  };
  const env = page.env ?? {};
  const mode = env.RS_RECEIVER_MODE ?? "file";
  if (mode !== "file" && mode !== "live")
    throw new UsageError(`RS_RECEIVER_MODE must be file or live (got ${mode})`);
  const out = env.RS_RECEIVER_OUT;
  if (!out) throw new UsageError("RS_RECEIVER_OUT is required");
  const recording = env.RS_RECEIVER_RECORDING ?? "";
  if (mode === "file" && !recording)
    throw new UsageError("RS_RECEIVER_RECORDING is required in file mode");
  const evidenceUrl = env.RS_RECEIVER_EVIDENCE_URL;
  if (!evidenceUrl)
    throw new UsageError("RS_RECEIVER_EVIDENCE_URL is required");
  const log = env.RS_RECEIVER_LOG ?? "full";
  if (log !== "full" && log !== "summary")
    throw new UsageError(
      `RS_RECEIVER_LOG must be full or summary (got ${log})`,
    );
  const cacheMode = orNull(env.RS_RECEIVER_CACHE_MODE);
  if (cacheMode !== null && cacheMode !== "fresh" && cacheMode !== "warm")
    throw new UsageError(
      `RS_RECEIVER_CACHE_MODE must be fresh or warm (got ${cacheMode})`,
    );
  return {
    mode,
    recording,
    out,
    shotSeqs: seqList("RS_RECEIVER_SHOT_SEQS", env.RS_RECEIVER_SHOT_SEQS),
    stateSeqs: seqList("RS_RECEIVER_STATE_SEQS", env.RS_RECEIVER_STATE_SEQS),
    store: orNull(env.RS_RECEIVER_STORE_DIR),
    cacheMode,
    shaderLibrary: orNull(env.RS_RECEIVER_SHADER_LIBRARY),
    fetchDelayMs:
      nonNegative(
        "RS_RECEIVER_FETCH_DELAY_MS",
        env.RS_RECEIVER_FETCH_DELAY_MS,
      ) ?? 0,
    sabotage: (env.RS_RECEIVER_SABOTAGE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    log,
    perfOut: orNull(env.RS_RECEIVER_PERF_OUT),
    memoryBudgetBytes: nonNegative(
      "RS_RECEIVER_MEMORY_BUDGET_BYTES",
      env.RS_RECEIVER_MEMORY_BUDGET_BYTES,
    ),
    cacheBudgetBytes: nonNegative(
      "RS_RECEIVER_CACHE_BUDGET_BYTES",
      env.RS_RECEIVER_CACHE_BUDGET_BYTES,
    ),
    buildSha256: orNull(env.RS_RECEIVER_BUILD_SHA256),
    manifestSha256: orNull(env.RS_RECEIVER_MANIFEST_SHA256),
    evidenceUrl,
    shellSabotage: page.sabotage ?? null,
    canvas: page.canvas ?? null,
    raw: Object.fromEntries(
      Object.entries(env).filter(([k]) => k.startsWith("RS_RECEIVER_")),
    ),
  };
}

/** The evidence path of a URL under dirname(out): "shots/seq-3.png" for ".../leg/shots/seq-3.png". */
export function relativeToOut(cfg: ReceiverConfig, url: string): string {
  const dir = cfg.out.slice(0, cfg.out.lastIndexOf("/") + 1);
  if (!url.startsWith(dir))
    throw new Error(`${url} is not under the evidence directory ${dir}`);
  return url.slice(dir.length);
}

/** The URL path of `<dirname(out)>/<rel>`. */
export function underOut(cfg: ReceiverConfig, rel: string): string {
  return cfg.out.slice(0, cfg.out.lastIndexOf("/") + 1) + rel;
}
