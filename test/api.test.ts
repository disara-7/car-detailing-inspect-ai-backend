import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app, { type Env } from "../src/index";
import { ErrorResponseSchema } from "../src/schema";
import { FAKE_IMAGE, geminiEnvelope, jsonResponse } from "./helpers";

const env: Env = {
  GEMINI_KEY: "test-key",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  ALLOWED_ORIGINS: "http://localhost:3000, https://example.com",
  GEMINI_MODEL: "test-model",
};

const validBody = {
  turnstileToken: "token",
  parts: [
    { category: "door", images: [FAKE_IMAGE] },
    { category: "glass", images: [FAKE_IMAGE] },
  ],
};

const geminiOutput = {
  parts: [
    { category: "door", score: 70, issues: ["Swirl marks"], services: ["Clay bar treatment"], photoQuality: "good" },
    { category: "glass", score: 10, issues: [], services: [], photoQuality: "good" },
  ],
};

function post(body: unknown, headers: Record<string, string> = {}, envOverride: Env = env) {
  return app.request(
    "/api/assess",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    envOverride,
  );
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = ErrorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
}

describe("API", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes("turnstile")) return jsonResponse({ success: true });
      return jsonResponse(geminiEnvelope(JSON.stringify(geminiOutput)));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GET /health", async () => {
    const res = await app.request("/health", {}, env);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns an assessment", async () => {
    const res = await post(validBody, { "CF-Connecting-IP": "203.0.113.1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // (1.0*70 + 0.5*10) / 1.5 = 50
    expect(body.overallScore).toBe(50);
    expect(body.overallLabel).toBe("light");
    expect(body.recommendedServices).toEqual(["Clay bar treatment"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const turnstileForm = fetchMock.mock.calls[0]![1].body as FormData;
    expect(turnstileForm.get("remoteip")).toBe("203.0.113.1");
  });

  it("rejects invalid JSON", async () => {
    await expectError(await post("{nope"), 400, "INVALID_REQUEST");
  });

  it("rejects schema violations", async () => {
    await expectError(await post({ ...validBody, parts: [] }), 400, "INVALID_REQUEST");
  });

  it("rejects bodies over 8 MB", async () => {
    const big = { ...validBody, parts: [{ category: "door", images: ["A".repeat(8 * 1024 * 1024 + 1)] }] };
    await expectError(await post(big), 413, "PAYLOAD_TOO_LARGE");
  });

  it("rejects a failed bot check without calling Gemini", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }));
    await expectError(await post(validBody), 403, "BOT_CHECK_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing token when Turnstile is enabled", async () => {
    const { turnstileToken: _omit, ...noToken } = validBody;
    await expectError(await post(noToken), 403, "BOT_CHECK_FAILED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips Turnstile when TURNSTILE_SECRET is not set", async () => {
    const { turnstileToken: _omit, ...noToken } = validBody;
    const { TURNSTILE_SECRET: _secret, ...envWithoutTurnstile } = env;
    const res = await post(noToken, {}, envWithoutTurnstile);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("generativelanguage.googleapis.com");
  });

  it("returns 429 when the rate limiter rejects the request", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const res = await post(validBody, { "CF-Connecting-IP": "203.0.113.9" }, {
      ...env,
      ASSESS_RATE_LIMITER: { limit } as unknown as RateLimit,
    });
    await expectError(res, 429, "RATE_LIMITED");
    expect(limit).toHaveBeenCalledWith({ key: "assess:203.0.113.9" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the request when the rate limiter accepts it", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const res = await post(validBody, {}, { ...env, ASSESS_RATE_LIMITER: { limit } as unknown as RateLimit });
    expect(res.status).toBe(200);
  });

  it("returns 502 when Gemini fails twice", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("turnstile") ? jsonResponse({ success: true }) : jsonResponse(geminiEnvelope("{bad")),
    );
    await expectError(await post(validBody), 502, "AI_FAILED");
  });

  it("answers CORS preflight for allowed origins only", async () => {
    const preflight = (origin: string) =>
      app.request(
        "/api/assess",
        {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
        },
        env,
      );
    const allowed = await preflight("https://example.com");
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://example.com");
    const denied = await preflight("https://evil.example");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns the error shape for unknown routes", async () => {
    await expectError(await app.request("/nope", {}, env), 404, "INVALID_REQUEST");
  });
});
