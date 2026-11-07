// LS0 (K5): the capture's validation logs (counters.json `captured`,
// the gate -1 / calibration / hook-log-golden evidence) run only under GRC_VALIDATION_LOG=on, and
// default off. counters.json carries `validation_log` ("on" | "off"). A checker that reads
// `captured` calls this first and refuses evidence from a run that did not ask for the log: an
// empty `captured` from an off run must never read as "the hook was never called".

/** The field of counters.json (hooks.cpp hooks_counters_json) a validation checker asserts. */
export interface ValidationLogCounters {
  validation_log?: unknown;
}

/** Why `counters` cannot back a validation check, or undefined when the log ran. Absent counters
 * are the caller's own "missing" finding. */
export function validationLogProblem(
  counters: ValidationLogCounters | undefined | null,
  path: string,
): string | undefined {
  if (counters === undefined || counters === null) return undefined;
  if (counters.validation_log === "on") return undefined;
  return `${path}: counters.json validation_log is ${JSON.stringify(counters.validation_log ?? null)}, not "on": the runner must set GRC_VALIDATION_LOG=on for a leg whose captured tables are judged`;
}

/** Refuses (throws) rather than judging an off run's empty tables. */
export function assertValidationLog(
  counters: ValidationLogCounters | undefined | null,
  path: string,
): void {
  const problem = validationLogProblem(counters, path);
  if (problem !== undefined) throw new Error(problem);
}
