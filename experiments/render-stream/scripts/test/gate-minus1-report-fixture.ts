// Gate -1 report rows use the same builder as the checker CLI.
import {
  type CriterionStatus,
  reportCriterion,
} from "../lib/gate-minus1-checks";

const reports = Object.fromEntries(
  (["pass", "fail", "unavailable"] as const).map((status: CriterionStatus) => [
    status,
    {
      schema: "render-stream-gate-report/1",
      gate: "-1",
      status: status === "pass" ? "pass" : "fail",
      criteria: ["pass", status].map((rowStatus, i) =>
        reportCriterion(
          {
            id: `criterion-${i + 1}`,
            description: "criterion fixture",
            status: rowStatus as CriterionStatus,
            evidence: "fixture",
          },
          i + 1,
        ),
      ),
      artifacts: { out: "fixture" },
    },
  ]),
);
console.log(JSON.stringify(reports));
