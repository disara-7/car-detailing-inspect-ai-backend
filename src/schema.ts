import { z } from "zod";

export const CATEGORIES = ["door","wheel","bonnet","roof","bumper","boot","glass","interior"] as const;
export const CategorySchema = z.enum(CATEGORIES);

export const AssessRequestSchema = z.object({
  turnstileToken: z.string().min(1),
  parts: z.array(z.object({
    category: CategorySchema,
    images: z.array(z.string().min(100)).min(1).max(4), // base64 JPEG, no "data:" prefix
  })).min(1).max(8),
}).refine(r => new Set(r.parts.map(p => p.category)).size === r.parts.length,
  { message: "Duplicate categories" });

export const PartResultSchema = z.object({
  category: CategorySchema,
  score: z.number().int().min(0).max(100),
  issues: z.array(z.string()).max(6),
  services: z.array(z.string()),
  photoQuality: z.enum(["good","poor"]),
});

export const AssessResponseSchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  overallLabel: z.enum(["clean","light","moderate","heavy"]),
  parts: z.array(PartResultSchema),
  recommendedServices: z.array(z.string()),
  disclaimer: z.string(),
});

export const ErrorCodeSchema = z.enum([
  "INVALID_REQUEST","BOT_CHECK_FAILED","PAYLOAD_TOO_LARGE","RATE_LIMITED","AI_FAILED","INTERNAL"]);
export const ErrorResponseSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
