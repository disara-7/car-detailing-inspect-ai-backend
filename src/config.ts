import type { z } from "zod";
import type { CategorySchema } from "./schema";

export type Category = z.infer<typeof CategorySchema>;

/** Relative importance of each part when computing the overall score. */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  door: 1.0,
  bonnet: 1.0,
  roof: 1.0,
  interior: 1.0,
  bumper: 0.8,
  boot: 0.8,
  wheel: 0.8,
  glass: 0.5,
};

/** Parts whose photos the AI marks as "poor" count at this fraction of their weight. */
export const POOR_PHOTO_WEIGHT_FACTOR = 0.5;

/** Upper bound (inclusive) of each overall label. */
export const LABEL_THRESHOLDS = {
  clean: 20,
  light: 50,
  moderate: 80,
  heavy: 100,
} as const;

/**
 * PLACEHOLDER service menu. Replace with your real service names.
 * Gemini may only recommend services from this list; anything else it returns is dropped.
 * The order here also breaks ties when ranking recommended services.
 */
export const SERVICES = [
  "Exterior wash and decontamination",
  "Clay bar treatment",
  "Single-stage paint correction",
  "Multi-stage paint correction",
  "Ceramic coating",
  "Wax or sealant",
  "Wheel deep clean",
  "Wheel refurbishment",
  "Glass polishing",
  "Headlight restoration",
  "Interior deep clean",
  "Leather treatment",
] as const;

export const DISCLAIMER =
  "These scores are an AI estimate based only on the photos provided. " +
  "A final quote requires an in-person inspection of the vehicle.";

/** Used when the GEMINI_MODEL env var is not set. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Total Gemini calls per request: the first attempt plus one retry. */
export const GEMINI_MAX_ATTEMPTS = 2;

/** Per-attempt timeout for the Gemini call. */
export const GEMINI_TIMEOUT_MS = 60_000;

/** Maximum accepted request body size (about 8 MB). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Rate limiting is configured in wrangler.jsonc ("ratelimits": ASSESS_RATE_LIMITER).
 * Requests are counted per client IP.
 */
export const RATE_LIMIT_KEY_PREFIX = "assess:";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
