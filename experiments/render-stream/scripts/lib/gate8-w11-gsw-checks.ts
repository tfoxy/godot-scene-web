// Gate 8 g8w11's GSW checks (W11c, protocol/render-stream-11.md "Receivers"), judged on the legs
// gate8-w11-tool.ts gsw-legs writes under <run>/g8w11/gsw/<leg>/gsw:
//
//   gsw-w11-replays         every honest leg (the /11 legs and their /10 twins) replays its whole
//                           recording: status ok, one applied transaction per recorded one
//   gsw-dynamic-applied     at every applied /11 transaction, the bodies GSW draws its dynamic
//                           meshes from (applied.json `dynamic_sha256`: per mesh id and surface,
//                           the held body's SHA-256) equal the TypeScript validator's resolved
//                           state (`body_sha256`), and no named dynamic mesh was left undrawn
//   gsw-w11-equals-v10      each /11 leg's shots equal its /10 twin's at the same frames, pixel for
//                           pixel (GSW's /10 path is judged against Godot by g7-5 and g7-6); the
//                           `off` legs too, so a returning hash (resend-applied) draws right
//   store-bounded           after every apply GSW's payload store holds at most |names(S)| + |C| +
//                           2 entries (the display's lag, a credit window's in-flight states), on
//                           every /11 leg, scale-off included (every pose a new inline hash)
//   inline-fetch-zero       no honest /11 leg fetched an inline-sized hash: GSW asks the validator
//                           before each GET, and a refusal fails the replay
//   *-caught                the receiver sabotages: stale-dynamic-rx fails gsw-dynamic-applied and
//                           the /10 equality; no-prune fails resource-duplicate; evict-carried
//                           fails inline-fetch-zero; ignore-released fails store-bounded
//
// The pure helpers are exported for scripts/test/self-test-gate8-w11-gsw.ts.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck } from "./gate8-adopt-checks";
import {
  type ResolvedRecording,
  resolveRecording,
  surfaceIsDynamic,
} from "./render-stream-2";

/** A /11 leg and its /10 twin (the shots' oracle). */
export const W11_TWINS: readonly [string, string][] = [
  ["scale", "scale-v10"],
  ["scale-off", "scale-v10"],
  ["scene", "scene-v10"],
  ["scene-off", "scene-v10"],
  ["mesh", "mesh-v10"],
];
export const W11_HONEST = ["scale", "scale-off", "scene", "scene-off", "mesh"];
const CAPTURE: Record<string, [string, string]> = {
  scale: ["scale/capture", "recording-patch.rs11"],
  "scale-off": ["scale/off/capture", "recording-patch.rs11"],
  scene: ["scene/capture", "recording-patch.rs11"],
  "scene-off": ["scene/off/capture", "recording-patch.rs11"],
  mesh: ["mesh/capture", "recording.rs11"],
  "scale-v10": ["scale/v10/capture", "recording-patch.rs10"],
  "scene-v10": ["scene/v10/capture", "recording-patch.rs10"],
  "mesh-v10": ["mesh/v10/capture", "recording.rs10"],
};
/** store-bounded's slack beyond |names| + |C|: the display's lag (credit window 2's states). */
export const STORE_SLACK = 2;

interface AppliedTx {
  seq: number;
  frame: number;
  dynamic_sha256?: string;
}
interface Applied {
  status: string;
  failure: { seq: number | null; reason: string; detail: string } | null;
  transactions: AppliedTx[];
}
interface W11Evidence {
  store_max_entries: number;
  store_max_excess: number;
  released_total: number;
  dynamic_bodies_total: number;
  dynamic_checked: number;
  dynamic_mismatched: number;
  first_mismatch_seq: number | null;
  dynamic_undrawn: number;
}

/** The digest gsw-rs writes as `dynamic_sha256`, from a resolved transaction: SHA-256 over every
 * `ok` dynamic mesh ascending by id, each surface's (id u32 LE, surface u32 LE, body_sha256). */
export function resolvedDynamicDigest(
  meshes: readonly {
    id: number;
    status: string;
    surfaces: readonly { hash: string | null; body_sha256?: string | null }[];
  }[],
): string {
  const parts: Buffer[] = [];
  const dyn = meshes
    .filter(
      (m) =>
        m.status === "ok" &&
        m.surfaces.length > 0 &&
        surfaceIsDynamic(m.surfaces[0]),
    )
    .sort((a, b) => a.id - b.id);
  for (const m of dyn)
    m.surfaces.forEach((s, k) => {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(m.id, 0);
      head.writeUInt32LE(k, 4);
      parts.push(head);
      parts.push(
        s.body_sha256 ? Buffer.from(s.body_sha256, "hex") : Buffer.alloc(32),
      );
    });
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

/** gsw-dynamic-applied's problems: seqs whose applied digest differs from the resolved one. */
export function dynamicAppliedProblems(
  rec: Pick<ResolvedRecording, "transactions">,
  applied: readonly AppliedTx[],
): { problems: string[]; compared: number; dynamicTxs: number } {
  const want = new Map<number, string>();
  const empty = resolvedDynamicDigest([]);
  let dynamicTxs = 0;
  for (const t of rec.transactions) {
    const d = resolvedDynamicDigest(t.state.meshes ?? []);
    if (d !== empty) dynamicTxs++;
    want.set(t.seq, d);
  }
  const problems: string[] = [];
  let compared = 0;
  for (const t of applied) {
    const w = want.get(t.seq);
    if (w === undefined) continue;
    if (t.dynamic_sha256 === undefined) {
      problems.push(`seq ${t.seq}: no dynamic_sha256`);
      continue;
    }
    compared++;
    if (t.dynamic_sha256 !== w) problems.push(`seq ${t.seq}: applied bodies differ`);
  }
  return { problems, compared, dynamicTxs };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Differing pixels between two shots (any RGBA channel), or null when one is missing. */
async function shotDiff(a: string, b: string): Promise<number | null> {
  const x = await decodePngRgba(a);
  const y = await decodePngRgba(b);
  if (!x || !y) return null;
  if (x.width !== y.width || x.height !== y.height) return x.width * x.height;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4)
    if (
      x.data[i] !== y.data[i] ||
      x.data[i + 1] !== y.data[i + 1] ||
      x.data[i + 2] !== y.data[i + 2] ||
      x.data[i + 3] !== y.data[i + 3]
    )
      n++;
  return n;
}

export async function runG8w11Gsw(g: string): Promise<G8aCheck[]> {
  const root = join(g, "gsw");
  const checks: G8aCheck[] = [];
  const web = (leg: string) => join(root, leg, "gsw");
  const ran = (leg: string) => existsSync(join(web(leg), "applied.json"));
  const tierSkipped = (leg: string) =>
    existsSync(join(web(leg), "skipped-by-tier.txt"));
  const applied = (leg: string) =>
    readJson<Applied>(join(web(leg), "applied.json"));
  const w11 = async (leg: string) =>
    (await readJson<{ gsw?: { w11?: W11Evidence } }>(join(web(leg), "perf.json")))
      ?.gsw?.w11 ?? null;
  const frames = (await readJson<Record<string, Record<string, number>>>(
    join(root, "frames.json"),
  )) ?? {};
  const recs = new Map<string, ResolvedRecording>();
  const recOf = async (leg: string) => {
    if (!recs.has(leg)) {
      const [cap, sink] = CAPTURE[leg];
      const path = join(g, cap, sink);
      if (!existsSync(path)) return null;
      const v = sink.endsWith(".rs11") ? 11 : 10;
      recs.set(leg, resolveRecording(new Uint8Array(await readFile(path)), v));
    }
    return recs.get(leg) ?? null;
  };
  const notRun = (id: string, criterion: string, leg: string): G8aCheck => ({
    id,
    criterion,
    passed: true,
    status: "not-run",
    detail: `skipped-by-tier: ${leg}`,
    gating: false,
  });

  // gsw-w11-replays
  {
    const legs = [...W11_HONEST, "scale-v10", "scene-v10", "mesh-v10"];
    const problems: string[] = [];
    for (const leg of legs) {
      const a = await applied(leg);
      const rec = await recOf(leg);
      if (!a || !rec) {
        problems.push(`${leg}: ${a ? "no capture" : "no applied.json"}`);
        continue;
      }
      if (a.status !== "ok")
        problems.push(`${leg}: ${a.failure?.reason}: ${a.failure?.detail?.slice(0, 160)}`);
      else if (a.transactions.length !== rec.transactions.length)
        problems.push(
          `${leg}: ${a.transactions.length} applied of ${rec.transactions.length}`,
        );
    }
    checks.push(
      check(
        "gsw-w11-replays",
        "W11c: GSW replays every g8w11 capture (/11 and the /10 twins) whole: status ok, every transaction applied",
        problems,
        `${legs.length} legs`,
      ),
    );
  }

  // gsw-dynamic-applied
  {
    const problems: string[] = [];
    const notes: string[] = [];
    let dynamic = 0;
    for (const leg of W11_HONEST) {
      const a = await applied(leg);
      const rec = await recOf(leg);
      const e = await w11(leg);
      if (!a || !rec || !e) {
        problems.push(`${leg}: evidence missing`);
        continue;
      }
      const r = dynamicAppliedProblems(rec, a.transactions);
      dynamic += r.dynamicTxs;
      problems.push(...r.problems.slice(0, 4).map((p) => `${leg}: ${p}`));
      if (e.dynamic_mismatched > 0)
        problems.push(`${leg}: ${e.dynamic_mismatched} surface(s) mismatched in wasm`);
      if (e.dynamic_undrawn > 0)
        problems.push(`${leg}: ${e.dynamic_undrawn} dynamic mesh(es) left undrawn`);
      notes.push(`${leg} ${r.compared} txs (${r.dynamicTxs} dynamic), ${e.dynamic_bodies_total} bodies`);
    }
    if (dynamic === 0) problems.push("no transaction held a dynamic mesh (vacuous)");
    checks.push(
      check(
        "gsw-dynamic-applied",
        "W11c: at every applied /11 transaction GSW draws each dynamic mesh from the body the TypeScript resolved state names (body_sha256), none left undrawn",
        problems,
        notes.join("; "),
      ),
    );
  }

  // gsw-w11-equals-v10 (and its use by stale-dynamic-rx)
  const twinDiff = async (leg: string, twin: string) => {
    const out: { frame: string; px: number | null }[] = [];
    const fl = frames[leg] ?? {};
    const ft = frames[twin] ?? {};
    for (const [frame, seq] of Object.entries(fl)) {
      const tseq = ft[frame];
      if (tseq === undefined) continue;
      out.push({
        frame,
        px: await shotDiff(
          join(web(leg), "shots", `seq-${seq}.png`),
          join(web(twin), "shots", `seq-${tseq}.png`),
        ),
      });
    }
    return out;
  };
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, twin] of W11_TWINS) {
      const d = await twinDiff(leg, twin);
      if (d.length === 0) problems.push(`${leg}: no shared shot frames with ${twin}`);
      for (const { frame, px } of d)
        if (px === null) problems.push(`${leg}: frame ${frame}: shot missing`);
        else if (px > 0) problems.push(`${leg}: frame ${frame}: ${px} px differ from ${twin}`);
      notes.push(`${leg} ${d.length} frames`);
    }
    checks.push(
      check(
        "gsw-w11-equals-v10",
        "W11c: each /11 leg's shots equal its /10 twin's at the same frames, pixel for pixel (resend-applied: the off legs' returning hashes included)",
        problems,
        notes.join("; "),
      ),
    );
  }

  // store-bounded
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const leg of W11_HONEST) {
      const e = await w11(leg);
      if (!e) {
        problems.push(`${leg}: no gsw.w11 evidence`);
        continue;
      }
      if (e.store_max_excess > STORE_SLACK)
        problems.push(`${leg}: ${e.store_max_excess} entries beyond |names| + |C|`);
      notes.push(`${leg} max ${e.store_max_entries} (excess ${e.store_max_excess}, released ${e.released_total})`);
    }
    checks.push(
      check(
        "store-bounded",
        `W11c: after every apply GSW's payload store holds at most |names(S)| + |C| + ${STORE_SLACK} entries`,
        problems,
        notes.join("; "),
      ),
    );
  }

  // inline-fetch-zero (honest): a GET of an inline-sized hash fails the replay, so the honest
  // legs' status is the check; the evict-carried sabotage shows the refusal fires.
  {
    const problems: string[] = [];
    for (const leg of W11_HONEST) {
      const a = await applied(leg);
      if (a?.failure?.reason === "inline-fetch-zero")
        problems.push(`${leg}: ${a.failure.detail.slice(0, 160)}`);
      else if (!a) problems.push(`${leg}: no applied.json`);
    }
    checks.push(
      check(
        "inline-fetch-zero",
        "W11c: no honest /11 leg asked for an inline-sized hash over HTTP (the fetcher asks Validator::check_fetch first)",
        problems,
      ),
    );
  }

  // the receiver sabotages
  const sabotage = async (
    id: string,
    leg: string,
    criterion: string,
    judge: () => Promise<string[]>,
  ) => {
    if (tierSkipped(leg)) {
      checks.push(notRun(id, criterion, leg));
      return;
    }
    if (!ran(leg)) {
      checks.push(check(id, criterion, null));
      return;
    }
    checks.push(check(id, criterion, await judge()));
  };
  await sabotage(
    "stale-dynamic-rx-caught",
    "sabotage-stale-dynamic-rx/scene",
    "W11c: a GSW that ignores dynamic bodies fails gsw-dynamic-applied and the /10 equality",
    async () => {
      const leg = "sabotage-stale-dynamic-rx/scene";
      const e = await w11(leg);
      const d = await twinDiff(leg, "scene-v10");
      const out: string[] = [];
      if (!e || e.dynamic_mismatched === 0)
        out.push("gsw-dynamic-applied passed: the ignored bodies went unseen");
      if (!d.some((x) => (x.px ?? 0) > 0))
        out.push("every shot equals the /10 twin's");
      return out;
    },
  );
  const failsWith = (leg: string, reason: RegExp) => async () => {
    const a = await applied(leg);
    const why = `${a?.failure?.reason ?? ""} ${a?.failure?.detail ?? ""}`;
    return a && a.status !== "ok" && reason.test(why)
      ? []
      : [`status ${a?.status}: ${why.slice(0, 160)}`];
  };
  await sabotage(
    "no-prune-caught",
    "sabotage-no-prune/scene-off",
    "W11c: a GSW that keeps C lifelong refuses the first returning hash, typed resource-duplicate",
    failsWith("sabotage-no-prune/scene-off", /resource-duplicate/),
  );
  await sabotage(
    "evict-carried-caught",
    "sabotage-evict-carried/scene-off",
    "W11c: a GSW that drops a hash still in C must fetch it, and the fetch is refused inline-fetch-zero",
    failsWith("sabotage-evict-carried/scene-off", /^inline-fetch-zero/),
  );
  await sabotage(
    "ignore-released-caught",
    "sabotage-ignore-released/scale-off",
    "W11c: a GSW that ignores Validator::released() fails store-bounded",
    async () => {
      const e = await w11("sabotage-ignore-released/scale-off");
      return e && e.store_max_excess > STORE_SLACK
        ? []
        : [`store excess ${e?.store_max_excess}: store-bounded passed`];
    },
  );
  return checks;
}
