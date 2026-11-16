import type { PartResult } from "../src/scoring";

/** A fake base64 "image" long enough to pass the 100-char minimum. */
export const FAKE_IMAGE = "A".repeat(200);

export function part(overrides: Partial<PartResult> & Pick<PartResult, "category">): PartResult {
  return {
    score: 50,
    issues: [],
    services: [],
    photoQuality: "good",
    ...overrides,
  };
}

/** Wraps model output text in a generateContent response envelope. */
export function geminiEnvelope(text: string) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
