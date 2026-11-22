/** /17 node and /19 material tween wire checks, independent of display playback. */
import type { BlockDescriptor, ResolvedState } from "./render-stream-2";

type ObjectValue = Record<string, unknown>;
type TweenType = "float" | "vector2" | "vector3" | "vector4" | "color";
interface Step {
  start_us: number;
  duration_us: number;
  trans: number;
  ease: number;
  from: number | null;
  to: number;
}
interface NodeStep extends Step {
  property: string;
}
interface MaterialStep extends Step {
  param: string;
  type: TweenType;
  component: number | null;
}
interface Begin<S> {
  op: "begin";
  tween_id: string;
  order: number;
  begin_us: number;
  end_us: number;
  steps: S[];
}
type NodeBegin = Begin<NodeStep> & { item: number };
type MaterialBegin = Begin<MaterialStep> & { material: number };
type TweenBegin = NodeBegin | MaterialBegin;
export interface TweenRecordMeta {
  type: "tween";
  seq: number;
  frame: number;
  t_us: number;
  events: (TweenBegin | { op: "cancel"; tween_id: string })[];
  poses: { item: number; kind: "node2d" | "control"; f: number }[];
  blocks: BlockDescriptor[];
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}
function object(v: unknown): ObjectValue {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    fail("meta-schema", "tween object");
  return v as ObjectValue;
}
function keys(v: unknown, expected: string[]): ObjectValue {
  const o = object(v);
  const actual = Object.keys(o);
  if (
    actual.length !== expected.length ||
    actual.some((k, i) => k !== expected[i])
  )
    fail("meta-schema", "tween keys or order");
  return o;
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    fail("meta-schema", "tween integer range");
  return v;
}
function id(v: unknown): number {
  return integer(v, 1, 0xffffffff);
}
function tweenId(v: unknown): void {
  if (typeof v !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(v))
    fail("meta-schema", "tween_id range or spelling");
  const n = BigInt(v);
  if (n.toString() !== v || n < -(1n << 63n) || n >= 1n << 63n)
    fail("meta-schema", "tween_id range or spelling");
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) fail("meta-schema", "tween array");
  return v;
}
function components(property: unknown): number[] {
  if (typeof property !== "string") fail("meta-schema", "tween property");
  const ranges: Record<string, number[]> = {
    position: [0, 1],
    rotation: [2],
    scale: [3, 4],
    skew: [5],
    modulate: [8, 9, 10, 11],
    self_modulate: [12, 13, 14, 15],
  };
  const [base, component, extra] = property.split(":");
  const range = ranges[base];
  if (!Object.hasOwn(ranges, base) || extra !== undefined)
    fail("meta-schema", "tween property");
  if (component === undefined) return range;
  const names =
    base === "position" || base === "scale"
      ? ["x", "y"]
      : base === "modulate" || base === "self_modulate"
        ? ["r", "g", "b", "a"]
        : [];
  const i = names.indexOf(component);
  if (i < 0) fail("meta-schema", "tween property");
  return [range[i]];
}
const arities = { float: 1, vector2: 2, vector3: 3, vector4: 4, color: 4 };
function materialComponents(step: MaterialStep): number[] {
  return step.component === null
    ? Array.from({ length: arities[step.type] }, (_, i) => i)
    : [step.component];
}
const stepKeys = ["start_us", "duration_us", "trans", "ease", "from", "to"];
function stepSchema(raw: unknown, material: boolean): void {
  const s = keys(raw, [
    ...(material ? ["param", "type", "component"] : ["property"]),
    ...stepKeys,
  ]);
  if (material) {
    if (
      typeof s.param !== "string" ||
      !/^[A-Za-z_]/.test(s.param) ||
      /[^A-Za-z0-9_]/.test(s.param)
    )
      fail("meta-schema", "material param name");
    if (typeof s.type !== "string" || !Object.hasOwn(arities, s.type))
      fail("meta-schema", "material param type");
    const n = arities[s.type as TweenType];
    if (s.component !== null && (n === 1 || integer(s.component) >= n))
      fail("meta-schema", "material component range");
  } else components(s.property);
  integer(s.trans, 0, 11);
  integer(s.ease, 0, 3);
  integer(s.start_us);
  integer(s.duration_us);
  if (s.from !== null) integer(s.from);
  integer(s.to);
}
function eventSchema(raw: unknown, version: number): void {
  const e = object(raw);
  if (e.op === "cancel") {
    keys(e, ["op", "tween_id"]);
    tweenId(e.tween_id);
    return;
  }
  if (e.op !== "begin") fail("meta-schema", "tween event");
  const material = Object.hasOwn(e, "material");
  if (material && version < 19) fail("meta-schema", "material tween below /19");
  keys(e, [
    "op",
    "tween_id",
    material ? "material" : "item",
    "order",
    "begin_us",
    "end_us",
    "steps",
  ]);
  tweenId(e.tween_id);
  id(material ? e.material : e.item);
  integer(e.order, 1);
  integer(e.begin_us);
  integer(e.end_us);
  for (const s of array(e.steps)) stepSchema(s, material);
}
function poseSchema(raw: unknown): void {
  const p = keys(raw, ["item", "kind", "f"]);
  id(p.item);
  integer(p.f);
  if (p.kind !== "node2d" && p.kind !== "control")
    fail("meta-schema", "tween node kind");
}

/** /19 preflights all scalar schema before offsets; /17-/18 decode in wire traversal order. */
export function checkTweenSchema(
  meta: unknown,
  version: number,
  metaText: string,
): string[] {
  try {
    const m = keys(meta, [
      "type",
      "seq",
      "frame",
      "t_us",
      "events",
      "poses",
      "blocks",
    ]);
    if (version < 17 || m.type !== "tween")
      fail("meta-schema", "tween version or type");
    // Tween decoders check canonical JSON after the ordered header, before scalar schema.
    if (JSON.stringify(m) !== metaText) fail("meta-noncanonical", "tween JSON");
    integer(m.seq, 1);
    integer(m.frame, 1);
    integer(m.t_us);
    if (version >= 19) {
      for (const e of array(m.events)) eventSchema(e, version);
      for (const p of array(m.poses)) poseSchema(p);
    }
    for (const b of array(m.blocks)) {
      const block = keys(b, ["name", "type", "count"]);
      if (block.name !== "tween_f32" || block.type !== "f32")
        fail("meta-schema", "tween block");
      integer(block.count, 1);
    }
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

/** Mirrors tweens::decode_version, including the three /19 float traversal phases. */
export function checkTweenValues(
  meta: TweenRecordMeta,
  floats: number[],
  version: number,
): string[] {
  try {
    let next = 0;
    const take = (at: unknown, n: number): number[] => {
      if (integer(at) !== next || next + n > floats.length)
        fail("tween-offset", "noncontiguous tween floats");
      const out = floats.slice(next, next + n);
      next += n;
      if (out.some((v) => !Number.isFinite(v)))
        fail("tween-offset", "nonfinite tween float");
      return out;
    };
    for (const e of array(meta.events)) {
      // /17 validates a step's timing scalars after its endpoints, as rs-core does.
      const event = object(e);
      if (
        version >= 19 ||
        event.op !== "begin" ||
        Object.hasOwn(event, "material")
      ) {
        eventSchema(e, version);
      } else {
        keys(event, [
          "op",
          "tween_id",
          "item",
          "order",
          "begin_us",
          "end_us",
          "steps",
        ]);
        tweenId(event.tween_id);
        id(event.item);
        integer(event.order, 1);
        integer(event.begin_us);
        integer(event.end_us);
        array(event.steps);
      }
      if (event.op !== "begin" || Object.hasOwn(event, "material")) continue;
      for (const raw of array(event.steps)) {
        const s = keys(raw, ["property", ...stepKeys]);
        const n = components(s.property).length;
        integer(s.trans, 0, 11);
        integer(s.ease, 0, 3);
        if (s.from !== null) take(s.from, n);
        take(s.to, n);
        integer(s.start_us);
        integer(s.duration_us);
      }
    }
    let last = 0;
    for (const raw of array(meta.poses)) {
      const p = keys(raw, ["item", "kind", "f"]);
      const item = id(p.item);
      if (version < 19 && item <= last)
        fail("tween-entry", "tween poses not ascending");
      last = item;
      if (p.kind !== "node2d" && p.kind !== "control")
        fail("meta-schema", "tween node kind");
      const values = take(p.f, 16);
      if (
        (p.kind === "node2d" && (values[6] !== 0 || values[7] !== 0)) ||
        (p.kind === "control" && values[5] !== 0)
      )
        fail("tween-offset", "tween fixed component");
    }
    for (const e of meta.events) {
      if (e.op !== "begin" || !("material" in e)) continue;
      for (const s of e.steps) {
        const n = materialComponents(s).length;
        if (s.from !== null) take(s.from, n);
        take(s.to, n);
      }
    }
    if (
      next !== floats.length ||
      (meta.events.length === 0 && meta.poses.length === 0)
    )
      fail("tween-offset", "unused tween floats or empty record");
    const time = (e: TweenBegin): number => {
      if (e.begin_us > meta.t_us) fail("tween-time", "future begin");
      let end = 0n;
      for (const s of e.steps) {
        const sum =
          BigInt(e.begin_us) + BigInt(s.start_us) + BigInt(s.duration_us);
        if (sum > BigInt(Number.MAX_SAFE_INTEGER))
          fail("tween-time", "tween timing overflow");
        if (sum > end) end = sum;
      }
      return Number(end);
    };
    if (version >= 19) {
      for (const e of meta.events) if (e.op === "begin") time(e);
      for (let i = 1; i < meta.poses.length; i++)
        if (meta.poses[i - 1].item >= meta.poses[i].item)
          fail("tween-entry", "tween poses not ascending");
    }
    for (const e of meta.events) {
      if (e.op !== "begin") continue;
      const end = time(e);
      if (e.steps.length === 0 || e.end_us !== end)
        fail("tween-entry", "empty steps or inconsistent end");
      if (!("item" in e)) continue;
      const pose = meta.poses.find((p) => p.item === e.item);
      if (!pose) fail("tween-entry", "begin missing pose");
      if (
        pose.kind === "control" &&
        e.steps.some((s) => components(s.property).includes(5))
      )
        fail("tween-entry", "Control skew");
    }
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

interface Live {
  begin: TweenBegin;
  claims: Set<string>;
}
/** Wire lifetime state is independent of playback and is copied until a transaction succeeds. */
export class TweenRegistry {
  private live = new Map<string, Live>();
  private kinds = new Map<number, string>();
  private precedence: [number, number] | null = null;

  transaction(
    time: number,
    record: TweenRecordMeta | null,
    state: ResolvedState,
  ): TweenRegistry | string {
    const next = new TweenRegistry();
    next.precedence = this.precedence;
    next.kinds = new Map(this.kinds);
    for (const [id, live] of this.live) {
      const b = live.begin;
      if (
        b.end_us > time &&
        ("item" in b
          ? state.items.has(b.item)
          : state.materials.has(b.material))
      )
        next.live.set(id, { begin: b, claims: new Set(live.claims) });
    }
    try {
      if (record !== null) {
        for (const item of next.kinds.keys())
          if (
            ![...next.live.values()].some(
              ({ begin: b }) => "item" in b && b.item === item,
            )
          )
            next.kinds.delete(item);
        for (const p of record.poses) {
          const old = next.kinds.get(p.item);
          if (old !== undefined && old !== p.kind)
            fail("tween-entry", "active item node kind changed");
          next.kinds.set(p.item, p.kind);
        }
        for (const e of record.events) {
          if (e.op === "cancel") {
            next.live.delete(e.tween_id);
            continue;
          }
          const p = next.precedence;
          if (
            next.live.has(e.tween_id) ||
            (p && (e.order < p[0] || (e.order === p[0] && e.begin_us <= p[1])))
          )
            fail("tween-entry", "duplicate live ID or begin precedence");
          if ("item" in e) {
            if (!state.items.has(e.item))
              fail("tween-entry", "begin item missing");
          } else {
            const m = state.materials.get(e.material);
            const shader =
              m?.shader == null ? undefined : state.shaders.get(m.shader);
            if (
              m?.status !== "ok" ||
              shader?.status !== "ok" ||
              shader.mode !== "canvas_item" ||
              shader.builtin !== null
            )
              fail("tween-entry", "unsupported begin material or shader");
            const types = new Map<string, TweenType>();
            for (const s of e.steps) {
              if (types.has(s.param) && types.get(s.param) !== s.type)
                fail("tween-entry", "inconsistent material param types");
              types.set(s.param, s.type);
              const param = m.params.find((p) => p.name === s.param);
              const values =
                typeof param?.value === "number" ? [param.value] : param?.value;
              if (
                param?.type !== s.type ||
                !Array.isArray(values) ||
                values.length !== arities[s.type] ||
                values.some(
                  (v) =>
                    typeof v !== "number" ||
                    !Number.isFinite(v) ||
                    !Number.isFinite(Math.fround(v)),
                )
              )
                fail(
                  "tween-entry",
                  "missing or incompatible material param baseline",
                );
            }
          }
          next.precedence = [e.order, e.begin_us];
          const claims = new Set<string>(
            "item" in e
              ? e.steps.flatMap((s) => components(s.property).map(String))
              : e.steps.flatMap((s) =>
                  materialComponents(s).map((c) => `${s.param}:${c}`),
                ),
          );
          for (const [id, old] of next.live) {
            const b = old.begin;
            const same =
              "item" in e
                ? "item" in b && b.item === e.item
                : "material" in b && b.material === e.material;
            if (same) for (const c of claims) old.claims.delete(c);
            if (old.claims.size === 0) next.live.delete(id);
          }
          if (e.end_us > time) next.live.set(e.tween_id, { begin: e, claims });
        }
      }
      for (const { begin: b } of next.live.values())
        if ("item" in b && !record?.poses.some((p) => p.item === b.item))
          fail("tween-entry", "active item missing pose");
      return next;
    } catch (e) {
      return (e as Error).message;
    }
  }
}
