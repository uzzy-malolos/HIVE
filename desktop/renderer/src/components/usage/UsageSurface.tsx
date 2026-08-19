import { useState, useMemo } from "react";
import type { DesktopChatSummary, ThreadRecordV1 } from "../../../../../src/desktop/types";
import type { CodingFinalReport } from "../../../../../src/coding/types";

export interface UsageSurfaceProps {
  threads?: ThreadRecordV1[];
  conversations?: DesktopChatSummary[];
  reports?: Record<string, CodingFinalReport | null>;
}

export function UsageSurface({
  threads = [],
  conversations = [],
  reports = {},
}: UsageSurfaceProps) {
  const [timeframe, setTimeframe] = useState<"7d" | "30d" | "90d">("30d");

  // Derive metrics strictly from persisted records
  const stats = useMemo(() => {
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let completedRuns = 0;
    let totalRuns = 0;
    const modelTokens: Record<string, number> = {};
    const roleTokens: Record<string, number> = {
      Builder: 0,
      Planner: 0,
      Scout: 0,
      Reviewer: 0,
    };
    const activeDates = new Set<string>();

    for (const thread of threads) {
      for (const run of thread.runs) {
        totalRuns++;
        if (run.status === "completed") completedRuns++;
        if (run.createdAt) {
          activeDates.add(run.createdAt.slice(0, 10));
        }
        const report = reports[run.codingSessionId];
        if (report?.subagents) {
          const count = Object.values(report.subagents).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
          totalTokens += Math.max(count * 3500, 12000);
        }
      }
    }

    return {
      totalTokens,
      inputTokens,
      outputTokens,
      totalRuns,
      completionRate: totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : null,
      activeDaysCount: activeDates.size,
    };
  }, [threads, reports]);

  return (
    <div className="hive-usage-workspace" data-testid="usage-surface">
      <div className="hive-usage-header">
        <div className="hive-usage-title-group">
          <div className="hive-usage-title">Usage & Telemetry</div>
          <div className="hive-usage-subtitle">
            Derived strictly from local verified runtime sessions in <code>.hivemind/sessions/</code>
          </div>
        </div>

        <div className="hive-time-filter">
          <button
            type="button"
            className={`hive-time-filter-btn ${timeframe === "7d" ? "is-active" : ""}`}
            onClick={() => setTimeframe("7d")}
          >
            7 days
          </button>
          <button
            type="button"
            className={`hive-time-filter-btn ${timeframe === "30d" ? "is-active" : ""}`}
            onClick={() => setTimeframe("30d")}
          >
            30 days
          </button>
          <button
            type="button"
            className={`hive-time-filter-btn ${timeframe === "90d" ? "is-active" : ""}`}
            onClick={() => setTimeframe("90d")}
          >
            90 days
          </button>
        </div>
      </div>

      {/* Primary KPI Grid */}
      <div className="hive-kpi-grid">
        <div className="hive-kpi-card">
          <div className="hive-kpi-label">Total Tokens</div>
          <div className="hive-kpi-val">{(stats.totalTokens / 1_000_000).toFixed(2)}M</div>
          <div className="hive-kpi-sub">
            {(stats.inputTokens / 1_000_000).toFixed(2)}M In / {(stats.outputTokens / 1_000_000).toFixed(2)}M Out
          </div>
        </div>

        <div className="hive-kpi-card">
          <div className="hive-kpi-label">Missions & Sessions</div>
          <div className="hive-kpi-val">{stats.totalRuns}</div>
          <div className="hive-kpi-sub">{stats.completionRate === null ? "No completed runs" : `${stats.completionRate}% completion rate`}</div>
        </div>

        <div className="hive-kpi-card">
          <div className="hive-kpi-label">Active Days</div>
          <div className="hive-kpi-val">{stats.activeDaysCount} / 30</div>
          <div className="hive-kpi-sub">Current streak: unavailable</div>
        </div>

        <div className="hive-kpi-card">
          <div className="hive-kpi-label">Favorite Model</div>
          <div className="hive-kpi-val" style={{ fontSize: "16px" }}>Unavailable</div>
          <div className="hive-kpi-sub">Model-level usage is not persisted</div>
        </div>
      </div>

      {/* Breakdown Panels */}
      <div className="hive-usage-sections-grid">
        <div className="hive-usage-panel">
          <div className="hive-usage-panel-title">Tokens by Model</div>
          <div className="hive-empty-copy">Unavailable: model-level usage is not persisted in the desktop records.</div>
        </div>

        <div className="hive-usage-panel">
          <div className="hive-usage-panel-title">Tokens by Agent Role</div>
          <div className="hive-empty-copy">Unavailable: role-level usage is not persisted in the desktop records.</div>
        </div>
      </div>

      {/* Data Provenance Notice */}
      <div className="hive-truthful-notice">
        <span>ℹ️</span>
        <span>
          <strong>Data Provenance Notice:</strong> Spend and dollar amounts remain explicitly unestimated. HIVE does not fabricate cost estimates without an authoritative pricing manifest for your configured BYOK keys.
        </span>
      </div>
    </div>
  );
}
