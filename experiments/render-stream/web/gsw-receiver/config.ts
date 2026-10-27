// GSW receiver configuration (gate7-design.md Q5, G7a): the native receiver's RS_RECEIVER_* names,
// read from the page URL. The harness maps a native leg's env.txt to this page exactly as it maps
// one for the web export (scripts/lib/gate7-web-legs.ts mapNativeLeg): `?env=<base64url JSON>` of
// `{env: {RS_RECEIVER_*: value}, canvas: [w, h], sabotage: "css-opacity" | null}`. Paths are
// same-origin URL paths. Nothing here is render-stream state; it is only what to read and where to
// write.
//
// Live mode (G7l) reads the native receiver's live variables (receiver.gd `_ready_live`) with the
// same rules and the same usage errors, plus the browser's: the page's `engine_args` (`--max-fps
// N`, wm.cpp's rule) or RS_RECEIVER_MAX_FPS, RS_RECEIVER_CREDIT_WINDOW (the /7 hello's request,
// default 2 since G7wd; 1 is explicit), and the bearer token, which comes from the page's fragment (never from `?env=`).

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
  /** G8kp (texture-delivery-design.md D3): RS_RECEIVER_TEXTURE_ENCODINGS (null: the module's
   * default `block,decoded`) and RS_RECEIVER_GPU_FORMAT_MASK (families left out of gpu_formats);
   * the module checks both against render-stream-9.md's grammar. */
  textureEncodings: string | null;
  gpuFormatMask: string | null;
  /** G8kb (texture-delivery-design.md D6, Q6 "GSW"): RS_RECEIVER_VARIANT_POLICY (`keep` or
   * `upgrade`; null: the module's default, upgrade on a context with neither bptc nor s3tc),
   * RS_RECEIVER_TRANSCODE_LOG=1 (each transcode's blocks SHA-256 in applied.json `transcodes[]`,
   * as the native receiver logs them) and the test fault RS_RECEIVER_TRANSCODE_FAULT=fail (every
   * transcode fails, so each uastc texture falls back to `decoded`: Q3's typed
   * `delivery-transcode-failed`). */
  variantPolicy: string | null;
  transcodeLog: boolean;
  transcodeFault: "fail" | null;
  /** G8kp: RS_RECEIVER_PROTOCOL (live): 7 (default), 8 (G8g: render-stream/8's live transport,
   * /7's with /8's tables; a gate 8 policy host offers only .8) or 9 (offers render-stream.9).
   * CG1: or 10 (offers render-stream.10; /10's back-buffer keys are typed, not composited).
   * W11c: or 11 (offers render-stream.11: dynamic meshes by id, the pruned carried set). */
  liveProtocol: 7 | 8 | 9 | 10 | 11;
  canvas: [number, number] | null;
  /** Every RS_RECEIVER_* value as given, for the log. */
  raw: Record<string, string>;
  /** G7l: live mode's options (null in file mode). */
  live: LiveConfig | null;
}

export interface ShotWindow {
  step: number;
  from: number;
  to: number;
  shot: boolean;
}

export interface LiveConfig {
  /** RS_RECEIVER_URL: ws://127.0.0.1:<port>/... or ws://[::1]:<port>/... */
  url: string;
  /** The HTTP origin of the resource GETs: the WebSocket's own host and port. */
  httpOrigin: string;
  windows: ShotWindow[];
  shotFinal: boolean;
  /** URL path of the received tap (default <dirname(out)>/received.rs<version>). */
  receivedOut: string;
  /** G8g: the live wire version (ReceiverConfig.liveProtocol, RS_RECEIVER_PROTOCOL): the received
   * tap's default name is received.rs<version>. */
  version: 7 | 8 | 9 | 10 | 11;
  /** RS_RECEIVER_RECEIVED_MAX_BYTES (receiver.gd's G7k cap, honoured here since G7v): store at
   * most this many received bytes in the tap; later messages are counted, not stored, and the
   * stream report says `received_truncated` (null: no cap, the default). */
  receivedMaxBytes: number | null;
  inboundBytes: number;
  /** W11c (W11t's transport, render-stream-11.md "Transport"): RS_RECEIVER_LIVE_CODING, the hello's
   * `live_coding` offer at /11: `zstd-base,zstd` (the default), `zstd`, or `off` (no key: the host
   * keeps the stream uncoded). Empty below /11, where the key does not exist. */
  liveCoding: string;
  connectTimeoutMs: number;
  creditStage: "submitted" | "applied";
  creditWindow: number;
  stall: { step: number; ms: number } | null;
  reconnect: number | null;
  reconnectMemory: "drop" | "keep";
  /** RS_RECEIVER_RECONNECT_ON_LOSS=1 (G7u, D14 as amended): a connection lost without an end
   * record (not a host 1002/1008/1009 close) reconnects with gate 1d's semantics. */
  reconnectOnLoss: boolean;
  resync: number | null;
  fetchTimeoutMs: number;
  /** `--max-fps N` (engine_args) or RS_RECEIVER_MAX_FPS; 0 is uncapped. */
  maxFps: number;
  /** The bearer token from the fragment, or null. Never logged or written. */
  token: string | null;
  /** RS_RECEIVER_DRAW_REPEAT (G7v, gate7-design.md Q13d `dev-gpu-headroom`): each drawing callback
   * draws the frame this many times into the stage target, every draw but the last overwritten
   * (default 1). The headroom leg's GPU load with no GPU counter. */
  drawRepeat: number;
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

function positive(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value.trim());
  if (!/^-?\d+$/.test(value.trim()) || n < 1)
    throw new UsageError(
      `${name} must be an integer >= 1 (got ${JSON.stringify(value)})`,
    );
  return n;
}

/** RS_RECEIVER_SHOT_WINDOWS (receiver.gd `_parse_windows`). */
function parseWindows(text: string | undefined): ShotWindow[] {
  const out: ShotWindow[] = [];
  if (text === undefined || text.trim() === "") return out;
  const steps = new Set<number>();
  for (const part of text.trim().split(",")) {
    const m = /^(\d+):(\d+)-(\d+)$/.exec(part.trim());
    const ok =
      m !== null &&
      Number(m[2]) >= 1 &&
      Number(m[2]) <= Number(m[3]) &&
      !steps.has(Number(m[1]));
    if (!ok || m === null)
      throw new UsageError(
        `RS_RECEIVER_SHOT_WINDOWS must be a CSV of <step>:<from>-<to> (got ${JSON.stringify(text)})`,
      );
    steps.add(Number(m[1]));
    out.push({
      step: Number(m[1]),
      from: Number(m[2]),
      to: Number(m[3]),
      shot: false,
    });
  }
  return out;
}

/** The live options (receiver.gd `_ready_live`, `_parse_g1d_options`). */
function readLive(
  env: Record<string, string>,
  out: string,
  engineArgs: string[],
  token: string | null,
): LiveConfig {
  for (const variable of [
    "RS_RECEIVER_RECORDING",
    "RS_RECEIVER_SHOT_SEQS",
    "RS_RECEIVER_STATE_SEQS",
  ])
    if ((env[variable] ?? "") !== "")
      throw new UsageError(
        `${variable} is a file-mode variable; live mode uses RS_RECEIVER_URL and RS_RECEIVER_SHOT_WINDOWS`,
      );
  const url = (env.RS_RECEIVER_URL ?? "").trim();
  const m = /^ws:\/\/(127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/.exec(url);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535)
    throw new UsageError(
      `RS_RECEIVER_URL must be ws://127.0.0.1:<port>/... or ws://[::1]:<port>/... (loopback only; got ${JSON.stringify(url)})`,
    );
  const windows = parseWindows(env.RS_RECEIVER_SHOT_WINDOWS);
  const shotFinal = (env.RS_RECEIVER_SHOT_FINAL ?? "").trim();
  if (shotFinal !== "" && shotFinal !== "1")
    throw new UsageError(
      `RS_RECEIVER_SHOT_FINAL must be 1 or unset (got ${JSON.stringify(shotFinal)})`,
    );
  const version = liveProtocol(env.RS_RECEIVER_PROTOCOL);
  const dir = out.slice(0, out.lastIndexOf("/") + 1);
  let receivedOut = (env.RS_RECEIVER_RECEIVED_OUT ?? "").trim();
  if (receivedOut === "") receivedOut = `${dir}received.rs${version}`;
  else if (!receivedOut.startsWith("/"))
    throw new UsageError(
      `RS_RECEIVER_RECEIVED_OUT must be absolute (got ${JSON.stringify(receivedOut)})`,
    );
  const stage = (env.RS_RECEIVER_CREDIT_STAGE ?? "").trim() || "submitted";
  if (stage !== "submitted" && stage !== "applied")
    throw new UsageError(
      `RS_RECEIVER_CREDIT_STAGE must be submitted or applied (got ${JSON.stringify(stage)})`,
    );
  const creditWindow = positive(
    "RS_RECEIVER_CREDIT_WINDOW",
    env.RS_RECEIVER_CREDIT_WINDOW,
    2,
  );
  let stall: LiveConfig["stall"] = null;
  const stallText = (env.RS_RECEIVER_STALL ?? "").trim();
  if (stallText !== "") {
    const sm = /^(\d+):(\d+)$/.exec(stallText);
    if (!sm || Number(sm[2]) < 1)
      throw new UsageError(
        `RS_RECEIVER_STALL must be <step>:<ms> with ms >= 1 (got ${JSON.stringify(stallText)})`,
      );
    stall = { step: Number(sm[1]), ms: Number(sm[2]) };
  }
  const stepOf = (variable: string): number | null => {
    const text = (env[variable] ?? "").trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text))
      throw new UsageError(
        `${variable} must be a step >= 0 (got ${JSON.stringify(text)})`,
      );
    return Number(text);
  };
  const reconnect = stepOf("RS_RECEIVER_RECONNECT");
  const resync = stepOf("RS_RECEIVER_RESYNC");
  const memory = (env.RS_RECEIVER_RECONNECT_MEMORY ?? "").trim() || "drop";
  if (memory !== "drop" && memory !== "keep")
    throw new UsageError(
      `RS_RECEIVER_RECONNECT_MEMORY must be drop or keep (got ${JSON.stringify(memory)})`,
    );
  const onLoss = (env.RS_RECEIVER_RECONNECT_ON_LOSS ?? "").trim();
  if (onLoss !== "" && onLoss !== "1")
    throw new UsageError(
      `RS_RECEIVER_RECONNECT_ON_LOSS must be 1 or unset (got ${JSON.stringify(onLoss)})`,
    );
  for (const [name, step] of [
    ["RS_RECEIVER_STALL", stall?.step ?? null],
    ["RS_RECEIVER_RECONNECT", reconnect],
    ["RS_RECEIVER_RESYNC", resync],
  ] as const)
    if (step !== null && !windows.some((w) => w.step === step))
      throw new UsageError(
        `${name} names step ${step}, which has no RS_RECEIVER_SHOT_WINDOWS window`,
      );
  let maxFps = 0;
  for (let i = 0; i < engineArgs.length; i++)
    if (engineArgs[i] === "--max-fps") {
      const v = engineArgs[i + 1] ?? "";
      if (!/^\d+$/.test(v))
        throw new UsageError(`--max-fps needs an integer (got ${v})`);
      maxFps = Number(v);
    }
  const envFps = nonNegative("RS_RECEIVER_MAX_FPS", env.RS_RECEIVER_MAX_FPS);
  if (envFps !== null) maxFps = envFps;
  if (token !== null && !/^[0-9a-f]{64}$/.test(token))
    throw new UsageError("the page fragment's token is not 64 lowercase hex");
  return {
    url,
    httpOrigin: `http://${m[1]}:${m[2]}`,
    windows,
    shotFinal: shotFinal === "1",
    receivedOut,
    version,
    receivedMaxBytes: nonNegative(
      "RS_RECEIVER_RECEIVED_MAX_BYTES",
      env.RS_RECEIVER_RECEIVED_MAX_BYTES,
    ),
    inboundBytes: positive(
      "RS_RECEIVER_INBOUND_BYTES",
      env.RS_RECEIVER_INBOUND_BYTES,
      16777216,
    ),
    liveCoding: liveCoding(env.RS_RECEIVER_LIVE_CODING, version),
    connectTimeoutMs: positive(
      "RS_RECEIVER_CONNECT_TIMEOUT",
      env.RS_RECEIVER_CONNECT_TIMEOUT,
      10000,
    ),
    creditStage: stage,
    creditWindow,
    stall,
    reconnect,
    reconnectMemory: memory,
    reconnectOnLoss: onLoss === "1",
    resync,
    fetchTimeoutMs:
      nonNegative(
        "RS_RECEIVER_FETCH_TIMEOUT_MS",
        env.RS_RECEIVER_FETCH_TIMEOUT_MS,
      ) ?? 10000,
    maxFps,
    token,
    drawRepeat: positive(
      "RS_RECEIVER_DRAW_REPEAT",
      env.RS_RECEIVER_DRAW_REPEAT,
      1,
    ),
  };
}

/** Parses `location.search` (and, live, the fragment's `token`). Throws UsageError (the native
 * receiver's exit 2) when malformed. */
export function readConfig(
  search: string,
  token: string | null = null,
): ReceiverConfig {
  const q = new URLSearchParams(search);
  const encoded = q.get("env");
  if (!encoded) throw new UsageError("no ?env= configuration");
  const page = JSON.parse(decodeBase64Url(encoded)) as {
    env?: Record<string, string>;
    engine_args?: string[];
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
    textureEncodings: orNull(env.RS_RECEIVER_TEXTURE_ENCODINGS),
    gpuFormatMask: orNull(env.RS_RECEIVER_GPU_FORMAT_MASK),
    variantPolicy: orNull(env.RS_RECEIVER_VARIANT_POLICY),
    transcodeLog: env.RS_RECEIVER_TRANSCODE_LOG === "1",
    transcodeFault: transcodeFault(env.RS_RECEIVER_TRANSCODE_FAULT),
    liveProtocol: liveProtocol(env.RS_RECEIVER_PROTOCOL),
    canvas: page.canvas ?? null,
    raw: Object.fromEntries(
      Object.entries(env).filter(([k]) => k.startsWith("RS_RECEIVER_")),
    ),
    live:
      mode === "live"
        ? readLive(env, out, page.engine_args ?? [], token)
        : null,
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

/** W11c: RS_RECEIVER_LIVE_CODING (the /11 hello's `live_coding` offer; "" sends no key). */
function liveCoding(value: string | undefined, version: number): string {
  const v = (value ?? "").trim();
  if (version < 11) {
    if (v !== "" && v !== "off")
      throw new UsageError(
        `RS_RECEIVER_LIVE_CODING needs RS_RECEIVER_PROTOCOL=11 (got ${v} at /${version})`,
      );
    return "";
  }
  if (v === "") return "zstd-base,zstd";
  if (v === "off") return "";
  if (v === "zstd-base,zstd" || v === "zstd") return v;
  throw new UsageError(
    `RS_RECEIVER_LIVE_CODING must be zstd-base,zstd, zstd or off (got ${v})`,
  );
}

/** G8kp: RS_RECEIVER_PROTOCOL for a GSW receiver: 7 (default), 8 (G8g: render-stream.8) or 9
 * (render-stream.9, the texture-delivery hello keys); CG1: 10 (render-stream.10, /9's hello). */
function liveProtocol(value: string | undefined): 7 | 8 | 9 | 10 | 11 {
  const v = (value ?? "").trim();
  if (v === "" || v === "7") return 7;
  if (v === "8") return 8;
  if (v === "9") return 9;
  if (v === "10") return 10;
  if (v === "11") return 11;
  throw new UsageError(
    `RS_RECEIVER_PROTOCOL must be 7, 8, 9, 10 or 11 for a GSW receiver (got ${v})`,
  );
}

/** G8kb: RS_RECEIVER_TRANSCODE_FAULT, a test fault (unset or `fail`). */
function transcodeFault(value: string | undefined): "fail" | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  if (v === "fail") return "fail";
  throw new UsageError(`RS_RECEIVER_TRANSCODE_FAULT must be fail (got ${v})`);
}
