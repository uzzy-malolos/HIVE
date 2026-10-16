import { describe, expect, it } from "vitest";
import { COMMERCIAL_ENTITLEMENTS, PLAN_IDS } from "../../src/commercial/contracts";
import {
  buildWorkspaceHome,
  designAvailability,
  earliestHostedDesign,
  evaluateHostedAccess,
} from "./workspace";

describe("workspace home", () => {
  it("fails closed for unknown plans, unknown entitlements, and every known pair", () => {
    expect(evaluateHostedAccess("nope", "cloud_sessions")).toEqual({ granted: false, reason: "unknown_plan" });
    expect(evaluateHostedAccess("pro", "nope")).toEqual({ granted: false, reason: "unknown_entitlement" });
    for (const plan of PLAN_IDS) {
      for (const entitlement of COMMERCIAL_ENTITLEMENTS) {
        expect(evaluateHostedAccess(plan, entitlement)).toEqual({ granted: false, reason: "not_connected" });
      }
    }
  });

  it("keeps Community free of commercial entitlements and matches the design matrix", () => {
    for (const entitlement of COMMERCIAL_ENTITLEMENTS) {
      expect(designAvailability("community", entitlement)).toBe("no");
      expect(earliestHostedDesign(entitlement)).not.toBeNull();
    }
    expect(designAvailability("pro", "cloud_sessions")).toBe("yes");
    expect(designAvailability("pro", "remote_runs")).toBe("limited");
    expect(designAvailability("power", "remote_runs")).toBe("yes");
    expect(designAvailability("pro", "scheduled_runs")).toBe("no");
    expect(designAvailability("power", "scheduled_runs")).toBe("yes");
    expect(designAvailability("pro", "managed_models")).toBe("optional");
    expect(designAvailability("team", "self_hosted_control_plane")).toBe("no");
    expect(designAvailability("enterprise", "self_hosted_control_plane")).toBe("yes");
  });

  it("builds a local preview with no money and no connected hosted boundary", () => {
    const home = buildWorkspaceHome();
    expect(home.schemaVersion).toBe(1);
    expect(home.plan).toEqual({ id: "community", label: "Community", authoritative: false });
    expect(home.account.session).toBe("not_connected");
    expect(home.measuredUsage).toBe("unavailable");
    expect(home.entitlements.map((row) => row.id)).toEqual([...COMMERCIAL_ENTITLEMENTS]);
    expect(home.entitlements.every((row) => row.community === "no" && row.access === "not_connected")).toBe(true);
    expect(home.boundaries.map((boundary) => boundary.state)).toEqual([
      "not_connected",
      "not_connected",
      "not_connected",
      "not_connected",
      "not_connected",
    ]);
    expect(home.hostedPlans.map((plan) => plan.id)).toEqual(["pro", "power", "team", "enterprise"]);
    expect(JSON.stringify(home)).not.toMatch(/USD|EUR|\$[0-9]/);
  });
});
