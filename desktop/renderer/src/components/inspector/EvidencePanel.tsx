import type { CodingFinalReport, HiveRunVerdict } from "../../../../../src/coding/types";

export interface EvidencePanelProps {
  report?: CodingFinalReport | null;
}

export function EvidencePanel({ report }: EvidencePanelProps) {
  if (!report) {
    return (
      <div className="hive-evidence-card" aria-label="Verification evidence">
        <div className="hive-verdict-banner is-pending">No evidence yet</div>
        <p className="hive-evidence-note">
          Verification results appear after this run records validation and review.
        </p>
      </div>
    );
  }

  const verdict = report.verdict;
  const reason = report.verdictReasons?.find((entry) => entry.trim().length > 0);

  return (
    <div className="hive-evidence-card" aria-label="Verification evidence">
      <div className={`hive-verdict-banner ${verdictTone(verdict)}`}>{verdict ?? "NO VERDICT"}</div>
      {reason ? <p className="hive-evidence-note">{clip(reason, 180)}</p> : null}
      <div className="hive-evidence-rows">
        {report.validation.length === 0 ? (
          <div className="hive-evidence-row">
            <span>Validation</span>
            <span className="hive-evidence-val">No checks recorded</span>
          </div>
        ) : report.validation.map((check, index) => (
          <div className="hive-evidence-row" key={`${check.label}-${index}`}>
            <span>{check.label}</span>
            <span className={statusClass(check.status)}>{check.status}</span>
          </div>
        ))}
        <div className="hive-evidence-row">
          <span>Reviewer findings</span>
          <span className="hive-evidence-val">{report.review.length === 0 ? "None recorded" : String(report.review.length)}</span>
        </div>
        {report.review.slice(0, 6).map((finding, index) => (
          <p className="hive-evidence-finding" key={`finding-${index}`}>{clip(finding, 160)}</p>
        ))}
        <div className="hive-evidence-row">
          <span>Outstanding</span>
          <span className="hive-evidence-val">{report.outstanding.length === 0 ? "None" : String(report.outstanding.length)}</span>
        </div>
      </div>
    </div>
  );
}

function verdictTone(verdict?: HiveRunVerdict): string {
  if (verdict === "ACCEPTED") return "is-accepted";
  if (verdict === "REPAIRABLE") return "is-repairable";
  if (verdict === "REJECTED") return "is-rejected";
  if (verdict === "BLOCKED") return "is-blocked";
  return "is-pending";
}

function statusClass(status: string): string {
  if (status === "passed") return "hive-evidence-val is-pass";
  if (status === "failed" || status === "cancelled") return "hive-evidence-val is-fail";
  return "hive-evidence-val";
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
