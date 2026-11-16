import type { z } from "zod";
import {
  CATEGORY_WEIGHTS,
  DISCLAIMER,
  LABEL_THRESHOLDS,
  POOR_PHOTO_WEIGHT_FACTOR,
  SERVICES,
} from "./config";
import type { AssessResponseSchema, PartResultSchema } from "./schema";

export type PartResult = z.infer<typeof PartResultSchema>;
export type AssessResponse = z.infer<typeof AssessResponseSchema>;
export type OverallLabel = AssessResponse["overallLabel"];

/** Effective weight of a part: its category weight, halved when the photos were poor. */
export function partWeight(part: Pick<PartResult, "category" | "photoQuality">): number {
  const base = CATEGORY_WEIGHTS[part.category];
  return part.photoQuality === "poor" ? base * POOR_PHOTO_WEIGHT_FACTOR : base;
}

/** Weighted average of the part scores, rounded to the nearest integer. */
export function computeOverallScore(parts: readonly PartResult[]): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const part of parts) {
    const w = partWeight(part);
    weightedSum += w * part.score;
    totalWeight += w;
  }
  if (totalWeight === 0) {
    throw new Error("Cannot compute an overall score without parts");
  }
  return Math.round(weightedSum / totalWeight);
}

export function labelForScore(score: number): OverallLabel {
  if (score <= LABEL_THRESHOLDS.clean) return "clean";
  if (score <= LABEL_THRESHOLDS.light) return "light";
  if (score <= LABEL_THRESHOLDS.moderate) return "moderate";
  return "heavy";
}

/**
 * Deduplicated union of every part's services, ordered by how many parts need each one
 * (most first). Ties keep the order of the service menu in config.ts, then alphabetical.
 */
export function rankServices(parts: readonly PartResult[]): string[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    for (const service of new Set(part.services)) {
      counts.set(service, (counts.get(service) ?? 0) + 1);
    }
  }
  const menuIndex = (s: string): number => {
    const i = (SERVICES as readonly string[]).indexOf(s);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...counts.keys()].sort(
    (a, b) =>
      (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
      menuIndex(a) - menuIndex(b) ||
      a.localeCompare(b),
  );
}

export function buildAssessResponse(parts: PartResult[]): AssessResponse {
  const overallScore = computeOverallScore(parts);
  return {
    overallScore,
    overallLabel: labelForScore(overallScore),
    parts,
    recommendedServices: rankServices(parts),
    disclaimer: DISCLAIMER,
  };
}
