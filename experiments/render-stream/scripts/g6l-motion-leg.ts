#!/usr/bin/env -S pnpm exec tsx --conditions=development
// G7mm: one g6l leg's motion-monotonic verdict, from the leg's own evidence only (applied.json and
// the host's live log), so run-gate6.sh can decide whether to rerun a failed leg right after it
// ends. The same judgement checkMotionMonotonic makes (judgeMotionLeg).
//
//   g6l-motion-leg.ts <live dir> <leg>      prints one JSON line {leg, pass, problems, note}
//   exit 0 pass, 1 fail, 2 usage / missing evidence

import {
  creditToSend,
  G6L_LEGS,
  judgeMotionLeg,
  loadG6lLeg,
} from "./lib/gate6l-checks";

async function main(): Promise<number> {
  const [liveDir, leg] = process.argv.slice(2);
  if (!liveDir || !leg || !G6L_LEGS.some((l) => l.leg === leg)) {
    console.error("usage: g6l-motion-leg.ts <live dir> <g6l leg>");
    return 2;
  }
  const ev = await loadG6lLeg(liveDir, leg);
  if (!ev.applied) {
    console.log(
      JSON.stringify({ leg, pass: false, problems: ["no applied.json"] }),
    );
    return 1;
  }
  const credit = ev.host
    ? ev.host.connections.map((c) => ({
        n: c.n,
        ...creditToSend(c.host.log),
      }))
    : null;
  const j = judgeMotionLeg(leg, ev.applied, credit);
  console.log(
    JSON.stringify({
      leg,
      pass: j.problems.length === 0,
      problems: j.problems,
      note: j.note,
    }),
  );
  return j.problems.length === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
