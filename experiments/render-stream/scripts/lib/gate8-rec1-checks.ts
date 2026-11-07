// Gate 8 g8rec1's checks:
// the client recorder. run-gate8.sh run_g8rec1 runs one live leg (`live/`): a headless
// fixtures/tag-scene host at /13 with a live tap, and scripts/client-record-check.ts driving
// web/client-record-check/ (the client package with the recorder on). The driver exports the
// recording to `live/page/recording.rs13`, replays it through rs-core-check, and writes
// `live/page/client-record.json`; the host's tap is `live/host/tap/stream-1.rs2`.
//
//   recorder-streamed      the leg streamed to the end and produced a recording
//   recording-replays      the export replays through rs-core-check (validate: ok)
//   recording-equals-tap   the export is byte-identical to the host's tap (the uncoded messages)
//   page-is-package-only   the page bundle imports nothing from web/gsw-receiver/

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";

interface RecReport {
  ended?: boolean;
  last_applied?: number;
  recording?: {
    records: number;
    fullSeq: number;
    overflow: boolean;
    resources: number;
  } | null;
  recording_bytes?: number;
  recording_sha256?: string;
  page_inputs?: number;
  page_harness_inputs?: string[];
  checks?: { id: string; passed: boolean; detail: string }[];
}

export async function runG8rec1(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const leg = "live";
  const pageDir = join(g, leg, "page");
  const mk = (
    id: string,
    criterion: string,
    problems: string[],
    detail: string,
    gating = true,
  ) =>
    checks.push({
      id,
      criterion,
      passed: problems.length === 0,
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0 ? detail : `${problems.join("; ")} (${detail})`,
      gating,
    });

  // run-gate8.sh run_g8rec1_leg writes `live/skipped.txt` when the host never listened. That is a
  // failure to run, not a tier skip, so it fails (gating); only the tier/remote markers skip.
  // The runner side stays as is: seven other legs write the same `skipped.txt` at their leg dir.
  const why = skipped(join(g, leg));
  if (why !== null) {
    mk("recorder-streamed", "the leg ran", [why], "skipped", false);
    return checks;
  }
  const noRun = join(g, leg, "skipped.txt");
  if (existsSync(noRun)) {
    mk(
      "recorder-streamed",
      "REC1: the client streams the live tag-scene host to its end and exports a recording",
      [`the leg did not run: ${readFileSync(noRun, "utf8").trim()}`],
      "skipped.txt",
    );
    return checks;
  }

  const report: RecReport | null = existsSync(
    join(pageDir, "client-record.json"),
  )
    ? (JSON.parse(
        readFileSync(join(pageDir, "client-record.json"), "utf8"),
      ) as RecReport)
    : null;

  // Health: streamed, ended, and produced a recording.
  {
    const problems: string[] = [];
    if (report === null) problems.push("no client-record.json");
    else {
      if (!report.ended) problems.push("the stream did not end");
      if ((report.last_applied ?? 0) < 1) problems.push("nothing applied");
      if (report.recording === null || report.recording === undefined)
        problems.push("no recording produced");
    }
    mk(
      "recorder-streamed",
      "REC1: the client streams the live tag-scene host to its end and exports a recording",
      problems,
      report
        ? `${report.last_applied} applies, ${report.recording?.records ?? 0} records, full seq ${report.recording?.fullSeq ?? "?"}, overflow ${report.recording?.overflow ?? "?"}`
        : "no report",
    );
  }

  // The export replays through rs-core-check (the driver ran `validate`).
  {
    const problems: string[] = [];
    const v = report?.checks?.find((c) => c.id === "recording-validates");
    if (v === undefined) problems.push("the driver did not run rs-core-check");
    else if (!v.passed) problems.push(`rs-core-check: ${v.detail}`);
    mk(
      "recording-replays",
      "REC1: the export replays through rs-core-check validate (ok)",
      problems,
      v?.detail ?? "no verdict",
    );
  }

  // Byte equality with the host's tap.
  {
    const rec = join(pageDir, "recording.rs13");
    const tap = join(g, leg, "host", "tap", "stream-1.rs2");
    const problems: string[] = [];
    let detail = "";
    if (!existsSync(rec)) problems.push("recording.rs13 is missing");
    if (!existsSync(tap))
      problems.push("the host's tap (stream-1.rs2) is missing");
    if (problems.length === 0) {
      const a = readFileSync(rec);
      const b = readFileSync(tap);
      if (a.length === 0) problems.push("the recording and the tap are empty");
      else if (a.equals(b)) detail = `${a.length} bytes, identical`;
      else {
        let first = 0;
        const n = Math.min(a.length, b.length);
        while (first < n && a[first] === b[first]) first++;
        problems.push(
          `${a.length} vs ${b.length} bytes differ first at ${first}`,
        );
        detail = `recording ${a.length} bytes, tap ${b.length} bytes`;
      }
    }
    mk(
      "recording-equals-tap",
      "REC1: the export is byte-identical to the host's tap (the capture's live tap holds the uncoded messages)",
      problems,
      detail,
    );
  }

  // The page must be the package alone (MIR-1's rule).
  {
    const problems: string[] = [];
    const list = report?.page_harness_inputs;
    // The field is the (expected empty) list of gsw-receiver inputs; a report without it, or one
    // whose bundle had no inputs at all, is no evidence.
    const n = Array.isArray(list) ? list.length : 0;
    if (report === null) problems.push("no client-record.json");
    else if (!Array.isArray(list))
      problems.push("report has no page_harness_inputs array");
    else if (!((report.page_inputs ?? 0) > 0))
      problems.push("report lists no bundle inputs");
    else if (n !== 0) problems.push(`${n} inputs from web/gsw-receiver/`);
    mk(
      "page-is-package-only",
      "REC1: the page bundle imports nothing from web/gsw-receiver/",
      problems,
      `${n} harness inputs`,
    );
  }

  return checks;
}
