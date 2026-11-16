import { z } from "zod";
import {
  GEMINI_API_BASE,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_TIMEOUT_MS,
  SERVICES,
  type Category,
} from "./config";
import { buildResponseJsonSchema, buildSystemInstruction, categoryLabel } from "./prompt";
import { PartResultSchema } from "./schema";
import type { PartResult } from "./scoring";

export interface PartInput {
  category: Category;
  /** Base64-encoded JPEG data, without a "data:" prefix. */
  images: string[];
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** Thrown when Gemini does not produce a valid assessment after all attempts. */
export class AiFailedError extends Error {
  override name = "AiFailedError";
}

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

/** Builds the generateContent request body. */
export function buildGeminiRequest(parts: readonly PartInput[], useResponseSchema: boolean) {
  const contentParts: GeminiPart[] = [];
  for (const part of parts) {
    contentParts.push({ text: categoryLabel(part.category) });
    for (const data of part.images) {
      contentParts.push({ inline_data: { mime_type: "image/jpeg", data } });
    }
  }

  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: "application/json",
  };
  if (useResponseSchema) {
    generationConfig.responseJsonSchema = buildResponseJsonSchema(parts.map((p) => p.category));
  }

  return {
    systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
    contents: [{ role: "user", parts: contentParts }],
    generationConfig,
  };
}

const GenerateContentResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }))
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
});

/** Concatenates the non-thought text parts of the first candidate. */
export function extractText(body: unknown): string | null {
  const parsed = GenerateContentResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const parts = parsed.data.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  return text.length > 0 ? text : null;
}

export type ParseResult = { ok: true; parts: PartResult[] } | { ok: false; reason: string };

const serviceLookup = new Map<string, string>(SERVICES.map((s) => [s.toLowerCase(), s]));

/** Maps service names to their canonical menu spelling and drops anything not on the menu. */
function normaliseServices(services: unknown): unknown {
  if (!Array.isArray(services)) return services;
  const out: string[] = [];
  for (const s of services) {
    if (typeof s !== "string") return services; // let Zod reject it
    const canonical = serviceLookup.get(s.trim().toLowerCase());
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function stripCodeFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m?.[1] ?? text.trim();
}

/**
 * Parses and validates Gemini's JSON output. Every requested category must appear exactly
 * once and nothing else may appear, so no score is ever invented or dropped.
 * Results are returned in the order the categories were requested.
 */
export function parseGeminiOutput(text: string, requested: readonly Category[]): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFences(text));
  } catch {
    return { ok: false, reason: "malformed_json" };
  }

  const envelope = z.object({ parts: z.array(z.unknown()) }).safeParse(json);
  if (!envelope.success) return { ok: false, reason: "missing_parts_array" };

  const byCategory = new Map<Category, PartResult>();
  for (const raw of envelope.data.parts) {
    const candidate =
      raw && typeof raw === "object"
        ? { ...raw, services: normaliseServices((raw as { services?: unknown }).services) }
        : raw;
    const result = PartResultSchema.safeParse(candidate);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join(".") || "(root)");
      return { ok: false, reason: `schema_mismatch:${paths.join(",")}` };
    }
    if (byCategory.has(result.data.category)) {
      return { ok: false, reason: "duplicate_category" };
    }
    byCategory.set(result.data.category, result.data);
  }

  const ordered: PartResult[] = [];
  for (const category of requested) {
    const part = byCategory.get(category);
    if (!part) return { ok: false, reason: "missing_category" };
    ordered.push(part);
  }
  if (byCategory.size !== requested.length) {
    return { ok: false, reason: "unexpected_category" };
  }
  return { ok: true, parts: ordered };
}

/**
 * Calls Gemini once with every part. If the call fails or the output does not validate,
 * retries once, then throws AiFailedError.
 *
 * If the first attempt gets HTTP 400 (for example the model rejects the response schema),
 * the retry is sent without the response schema; the output is still fully validated.
 */
export async function assessWithGemini(
  parts: readonly PartInput[],
  options: GeminiOptions,
): Promise<PartResult[]> {
  const requested = parts.map((p) => p.category);
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(options.model)}:generateContent`;
  let useResponseSchema = true;

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    const log = (fields: Record<string, unknown>) =>
      console.log(
        JSON.stringify({ event: "gemini_attempt", attempt, ms: Date.now() - started, ...fields }),
      );

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
        body: JSON.stringify(buildGeminiRequest(parts, useResponseSchema)),
        signal: AbortSignal.timeout(options.timeoutMs ?? GEMINI_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      log({ outcome: timedOut ? "timeout" : "network_error" });
      continue;
    }

    if (!res.ok) {
      log({ outcome: "http_error", status: res.status, schema: useResponseSchema });
      if (res.status === 400) useResponseSchema = false;
      continue;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log({ outcome: "invalid_envelope", status: res.status });
      continue;
    }

    const text = extractText(body);
    if (text === null) {
      log({ outcome: "empty_output", status: res.status });
      continue;
    }

    const parsed = parseGeminiOutput(text, requested);
    if (!parsed.ok) {
      log({ outcome: "invalid_output", status: res.status, reason: parsed.reason });
      continue;
    }

    log({ outcome: "ok", status: res.status });
    return parsed.parts;
  }

  throw new AiFailedError("Gemini did not return a valid assessment");
}
