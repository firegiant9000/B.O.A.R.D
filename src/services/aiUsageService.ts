import {
  doc,
  getDoc,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { WorkspaceRole } from "../types";

// Client read path for AI cost telemetry (Month 4, Phase 2). The Cloud Function
// owns the writes (functions/src/ai/usage.ts); this only reads `aiUsage`/`aiLog`
// for the read-only usage settings page. firestore.rules gates both reads to
// workspace owner/admin and denies all client writes — so this service never writes.

/** Roles allowed to view the usage page, mirroring the aiUsage/aiLog read rule. */
const VIEWER_ROLES: WorkspaceRole[] = ["owner", "admin"];

export interface AiFeatureUsage {
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsagePeriod {
  period: string;
  calls: number;
  tokens: number;
  costUsd: number;
  byFeature: Record<string, AiFeatureUsage>;
}

export interface AiLogEntry {
  id: string;
  uid: string;
  feature: string;
  model: string;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
}

/** The UTC year-month bucket for a date — matches `currentPeriod` in the function
 *  so the client reads the same doc the function writes. */
export function periodFor(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Whether `role` may view the usage page (owner/admin only, per the rules). */
export function canViewUsage(role: WorkspaceRole | undefined): boolean {
  return role !== undefined && VIEWER_ROLES.includes(role);
}

/** Maps a raw aiUsage doc to a typed period, tolerating missing fields so a
 *  partially-written or older-shape doc never throws (schema-version tolerance). */
export function mapUsageDoc(
  period: string,
  data: Record<string, any> | undefined
): AiUsagePeriod {
  const byFeatureRaw = (data?.byFeature ?? {}) as Record<string, any>;
  const byFeature: Record<string, AiFeatureUsage> = {};
  for (const [feature, v] of Object.entries(byFeatureRaw)) {
    byFeature[feature] = {
      calls: v?.calls ?? 0,
      tokens: v?.tokens ?? 0,
      costUsd: v?.costUsd ?? 0,
    };
  }
  return {
    period,
    calls: data?.calls ?? 0,
    tokens: data?.tokens ?? 0,
    costUsd: data?.costUsd ?? 0,
    byFeature,
  };
}

/** Reads one period's usage counter. Returns a zeroed period when none exists yet
 *  (no AI calls this month) so the page renders an empty state, not an error. */
export async function getAiUsage(
  workspaceId: string,
  period: string = periodFor()
): Promise<AiUsagePeriod> {
  const snap = await getDoc(doc(db, "workspaces", workspaceId, "aiUsage", period));
  return mapUsageDoc(period, snap.exists() ? snap.data() : undefined);
}

/** Most-recent per-call log rows for the usage page's activity list. Ordered by
 *  `createdAt` (single-field, auto-indexed). Capped to keep the read bounded. */
export async function getRecentAiLog(
  workspaceId: string,
  max = 25
): Promise<AiLogEntry[]> {
  const q = query(
    collection(db, "workspaces", workspaceId, "aiLog"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      uid: data.uid ?? "",
      feature: data.feature ?? "unknown",
      model: data.model ?? "",
      totalTokens: data.totalTokens ?? 0,
      costUsd: data.costUsd ?? 0,
      createdAt: data.createdAt ?? 0,
    };
  });
}

/** Formats a USD cost for display. Sub-cent values show 4 decimals so a single
 *  fraction-of-a-cent call isn't rounded to "$0.00"; larger sums show 2. */
export function formatUsd(cost: number): string {
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
