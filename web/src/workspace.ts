import {
  COMMERCIAL_ENTITLEMENTS,
  PLAN_IDS,
  isCommercialEntitlement,
  isPlanId,
  type CommercialEntitlement,
  type PlanId,
} from "../../src/commercial/contracts";

/** Local preview of the hosted workspace home. Nothing here is server-authoritative. */
export const WORKSPACE_HOME_SCHEMA_VERSION = 1 as const;

export const PLAN_LABELS: Record<PlanId, string> = {
  community: "Community",
  pro: "Pro",
  power: "Power",
  team: "Team",
  enterprise: "Enterprise",
};

export const ENTITLEMENT_LABELS: Record<CommercialEntitlement, string> = {
  cloud_sessions: "Cloud session sync",
  remote_runs: "Remote execution",
  github_automation: "GitHub automation",
  scheduled_runs: "Scheduled remote runs",
  private_presets: "Private hosted presets",
  api_access: "Commercial API access",
  webhooks: "Outbound webhooks",
  team_workspaces: "Shared workspaces",
  shared_provider_registry: "Shared provider configuration",
  approval_policies: "Central approval policies",
  audit_logs: "Organization audit log",
  managed_models: "HIVE-managed model access",
  self_hosted_control_plane: "Customer control plane",
};

/** Design matrix from docs/monetization/FEATURE_ENTITLEMENT_MATRIX.md. Not an access grant. */
export type DesignAvailability = "no" | "limited" | "yes" | "optional";

const ENTITLEMENT_MATRIX: Record<CommercialEntitlement, Record<PlanId, DesignAvailability>> = {
  cloud_sessions: { community: "no", pro: "yes", power: "yes", team: "yes", enterprise: "yes" },
  remote_runs: { community: "no", pro: "limited", power: "yes", team: "yes", enterprise: "yes" },
  github_automation: { community: "no", pro: "yes", power: "yes", team: "yes", enterprise: "yes" },
  scheduled_runs: { community: "no", pro: "no", power: "yes", team: "yes", enterprise: "yes" },
  private_presets: { community: "no", pro: "yes", power: "yes", team: "yes", enterprise: "yes" },
  api_access: { community: "no", pro: "no", power: "yes", team: "yes", enterprise: "yes" },
  webhooks: { community: "no", pro: "no", power: "yes", team: "yes", enterprise: "yes" },
  team_workspaces: { community: "no", pro: "no", power: "no", team: "yes", enterprise: "yes" },
  shared_provider_registry: { community: "no", pro: "no", power: "no", team: "yes", enterprise: "yes" },
  approval_policies: { community: "no", pro: "no", power: "no", team: "yes", enterprise: "yes" },
  audit_logs: { community: "no", pro: "no", power: "no", team: "yes", enterprise: "yes" },
  managed_models: { community: "no", pro: "optional", power: "optional", team: "optional", enterprise: "optional" },
  self_hosted_control_plane: { community: "no", pro: "no", power: "no", team: "no", enterprise: "yes" },
};

export type AccessDecision = {
  granted: false;
  reason: "unknown_plan" | "unknown_entitlement" | "not_connected";
};

export type HostedBoundaryId = "authentication" | "billing" | "metering" | "github" | "cloud_execution";

export interface HostedBoundary {
  id: HostedBoundaryId;
  label: string;
  state: "not_connected";
  detail: string;
}

export interface WorkspaceHome {
  schemaVersion: typeof WORKSPACE_HOME_SCHEMA_VERSION;
  account: {
    kind: "local_preview";
    session: "not_connected";
    label: "Local preview";
  };
  workspace: {
    id: "preview-personal";
    name: "Personal workspace";
    role: "owner";
    status: "preview";
  };
  plan: {
    id: "community";
    label: "Community";
    authoritative: false;
  };
  hostedPlans: Array<{
    id: Exclude<PlanId, "community">;
    label: string;
    availability: "designed_only";
  }>;
  entitlements: Array<{
    id: CommercialEntitlement;
    label: string;
    community: "no";
    designedFor: string;
    access: "not_connected";
  }>;
  boundaries: HostedBoundary[];
  measuredUsage: "unavailable";
  localRuntime: {
    hiveChat: string;
    hiveCode: string;
    verifiedRuns: string;
    byok: string;
    pushCommand: "hive push --confirmed";
  };
}

export function designAvailability(plan: PlanId, entitlement: CommercialEntitlement): DesignAvailability {
  return ENTITLEMENT_MATRIX[entitlement][plan];
}

export function earliestHostedDesign(entitlement: CommercialEntitlement): {
  plan: Exclude<PlanId, "community">;
  availability: Exclude<DesignAvailability, "no">;
} | null {
  for (const plan of PLAN_IDS) {
    if (plan === "community") continue;
    const availability = ENTITLEMENT_MATRIX[entitlement][plan];
    if (availability !== "no") {
      return { plan, availability };
    }
  }
  return null;
}

/** Hosted access fails closed until a server evaluator exists. */
export function evaluateHostedAccess(plan: string, entitlement: string): AccessDecision {
  if (!isPlanId(plan)) return { granted: false, reason: "unknown_plan" };
  if (!isCommercialEntitlement(entitlement)) return { granted: false, reason: "unknown_entitlement" };
  return { granted: false, reason: "not_connected" };
}

function formatDesign(entitlement: CommercialEntitlement): string {
  const earliest = earliestHostedDesign(entitlement);
  if (!earliest) return "None";
  const name = PLAN_LABELS[earliest.plan];
  if (earliest.availability === "yes") return name;
  if (earliest.availability === "limited") return `${name} (limited)`;
  return `${name} (optional)`;
}

const HOSTED_BOUNDARIES: HostedBoundary[] = [
  {
    id: "authentication",
    label: "Sign-in",
    state: "not_connected",
    detail: "Browser sessions are not connected. This workspace is a local preview.",
  },
  {
    id: "billing",
    label: "Billing",
    state: "not_connected",
    detail: "No payment provider, checkout, or webhook is connected. Billing reads a server ledger when one exists.",
  },
  {
    id: "metering",
    label: "Usage ledger",
    state: "not_connected",
    detail: "The append-only usage ledger is not connected. Measured usage is unavailable. Local run reports stay engineering evidence.",
  },
  {
    id: "github",
    label: "GitHub",
    state: "not_connected",
    detail: "GitHub linking is not connected. A linked identity would still need a separate repository grant.",
  },
  {
    id: "cloud_execution",
    label: "Live runs",
    state: "not_connected",
    detail: "Remote and scheduled runs are not connected. Verified runs stay on the local runtime.",
  },
];

export function buildWorkspaceHome(): WorkspaceHome {
  const entitlements = COMMERCIAL_ENTITLEMENTS.map((id) => {
    const community = designAvailability("community", id);
    if (community !== "no") {
      throw new Error(`Community must not include ${id}.`);
    }
    return {
      id,
      label: ENTITLEMENT_LABELS[id],
      community,
      designedFor: formatDesign(id),
      access: "not_connected" as const,
    };
  });

  const hostedPlans = PLAN_IDS.filter((id): id is Exclude<PlanId, "community"> => id !== "community").map((id) => ({
    id,
    label: PLAN_LABELS[id],
    availability: "designed_only" as const,
  }));

  return {
    schemaVersion: WORKSPACE_HOME_SCHEMA_VERSION,
    account: {
      kind: "local_preview",
      session: "not_connected",
      label: "Local preview",
    },
    workspace: {
      id: "preview-personal",
      name: "Personal workspace",
      role: "owner",
      status: "preview",
    },
    plan: {
      id: "community",
      label: "Community",
      authoritative: false,
    },
    hostedPlans,
    entitlements,
    boundaries: HOSTED_BOUNDARIES,
    measuredUsage: "unavailable",
    localRuntime: {
      hiveChat: "Chat with BYOK personas and hand real work to Hive Code.",
      hiveCode: "Plan, build, validate, and review changes in isolated worktrees.",
      verifiedRuns: "Verified runs stay on this machine. The local runtime keeps working while this control plane is offline.",
      byok: "HiveChat and Hive Code use bring-your-own-key providers. This preview stores no provider keys.",
      pushCommand: "hive push --confirmed",
    },
  };
}
