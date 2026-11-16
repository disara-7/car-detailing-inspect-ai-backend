import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { DEFAULT_GEMINI_MODEL, MAX_BODY_BYTES, RATE_LIMIT_KEY_PREFIX } from "./config";
import { AiFailedError, assessWithGemini } from "./gemini";
import { AssessRequestSchema, AssessResponseSchema, type ErrorCodeSchema } from "./schema";
import { buildAssessResponse } from "./scoring";
import { verifyTurnstile } from "./turnstile";

export interface Env {
  GEMINI_KEY: string;
  /** Optional. When set, every request must carry a valid Turnstile token. */
  TURNSTILE_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  GEMINI_MODEL?: string;
  /** Workers Rate Limiting binding (wrangler.jsonc "ratelimits"). Skipped if absent. */
  ASSESS_RATE_LIMITER?: RateLimit;
}

type ErrorCode = z.infer<typeof ErrorCodeSchema>;

function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Accepts an optional "data:image/...;base64," prefix even though the contract says not to send one. */
function stripDataUrlPrefix(image: string): string {
  return image.replace(/^data:[^;,]+;base64,/, "");
}

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin, c) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.post(
  "/api/assess",
  // Rate limit first, so throttled clients cost no body parsing, Turnstile or Gemini calls.
  async (c, next) => {
    const limiter = c.env.ASSESS_RATE_LIMITER;
    if (limiter) {
      const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
      const { success } = await limiter.limit({ key: RATE_LIMIT_KEY_PREFIX + ip });
      if (!success) {
        console.warn(JSON.stringify({ event: "rate_limited" }));
        return errorResponse(
          c,
          429,
          "RATE_LIMITED",
          "Too many assessments. Please wait a minute and try again.",
        );
      }
    }
    await next();
  },
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      errorResponse(c, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds the 8 MB limit"),
  }),
  async (c) => {
    const started = Date.now();

    if (!c.env.GEMINI_KEY) {
      console.error(JSON.stringify({ event: "misconfigured", missing: "GEMINI_KEY" }));
      return errorResponse(c, 500, "INTERNAL", "Server is not configured");
    }

    let json: unknown;
    try {
      json = JSON.parse(await c.req.text());
    } catch {
      return errorResponse(c, 400, "INVALID_REQUEST", "Body must be valid JSON");
    }

    const parsed = AssessRequestSchema.safeParse(json);
    if (!parsed.success) {
      const message = parsed.error.issues
        .slice(0, 5)
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      return errorResponse(c, 400, "INVALID_REQUEST", message);
    }
    const request = parsed.data;
    const categories = request.parts.map((p) => p.category);
    const imageCount = request.parts.reduce((n, p) => n + p.images.length, 0);

    // Turnstile is optional: it is enforced only when TURNSTILE_SECRET is configured.
    if (c.env.TURNSTILE_SECRET) {
      const human =
        request.turnstileToken !== undefined &&
        (await verifyTurnstile(
          request.turnstileToken,
          c.env.TURNSTILE_SECRET,
          c.req.header("CF-Connecting-IP"),
        ));
      if (!human) {
        return errorResponse(c, 403, "BOT_CHECK_FAILED", "Bot check failed. Please try again.");
      }
    }

    let partResults;
    try {
      partResults = await assessWithGemini(
        request.parts.map((p) => ({ category: p.category, images: p.images.map(stripDataUrlPrefix) })),
        { apiKey: c.env.GEMINI_KEY, model: c.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL },
      );
    } catch (err) {
      if (err instanceof AiFailedError) {
        console.warn(
          JSON.stringify({ event: "assess_failed", categories, imageCount, ms: Date.now() - started }),
        );
        return errorResponse(c, 502, "AI_FAILED", "The AI assessment failed. Please try again.");
      }
      throw err;
    }

    const response = AssessResponseSchema.safeParse(buildAssessResponse(partResults));
    if (!response.success) {
      console.error(JSON.stringify({ event: "response_validation_failed" }));
      return errorResponse(c, 500, "INTERNAL", "Internal error");
    }

    console.log(
      JSON.stringify({
        event: "assess_ok",
        categories,
        imageCount,
        overallScore: response.data.overallScore,
        ms: Date.now() - started,
      }),
    );
    return c.json(response.data, 200);
  },
);

app.notFound((c) => errorResponse(c, 404, "INVALID_REQUEST", "Not found"));

app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", name: err.name }));
  return errorResponse(c, 500, "INTERNAL", "Internal error");
});

export default app;
