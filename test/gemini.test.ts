import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiFailedError,
  assessWithGemini,
  buildGeminiRequest,
  extractText,
  parseGeminiOutput,
} from "../src/gemini";
import { FAKE_IMAGE, geminiEnvelope, jsonResponse } from "./helpers";

const validOutput = {
  parts: [
    {
      category: "door",
      score: 60,
      issues: ["Swirl marks"],
      services: ["Single-stage paint correction"],
      photoQuality: "good",
    },
    { category: "wheel", score: 30, issues: [], services: [], photoQuality: "poor" },
  ],
};

describe("parseGeminiOutput", () => {
  it("parses valid JSON and returns parts in request order", () => {
    const result = parseGeminiOutput(JSON.stringify(validOutput), ["wheel", "door"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parts.map((p) => p.category)).toEqual(["wheel", "door"]);
  });

  it("accepts JSON wrapped in code fences", () => {
    const text = "```json\n" + JSON.stringify(validOutput) + "\n```";
    expect(parseGeminiOutput(text, ["door", "wheel"]).ok).toBe(true);
  });

  it("normalises service names and drops services not on the menu", () => {
    const output = {
      parts: [
        {
          ...validOutput.parts[0],
          services: ["clay BAR treatment", "Rust proofing", "Clay bar treatment"],
        },
      ],
    };
    const result = parseGeminiOutput(JSON.stringify(output), ["door"]);
    expect(result.ok && result.parts[0]?.services).toEqual(["Clay bar treatment"]);
  });

  it.each([
    ["malformed JSON", "{not json", "malformed_json"],
    ["missing parts array", JSON.stringify({ result: [] }), "missing_parts_array"],
    [
      "score out of range",
      JSON.stringify({ parts: [{ ...validOutput.parts[0], score: 150 }, validOutput.parts[1]] }),
      "schema_mismatch",
    ],
    [
      "missing category",
      JSON.stringify({ parts: [validOutput.parts[0]] }),
      "missing_category",
    ],
    [
      "unexpected category",
      JSON.stringify({ parts: [...validOutput.parts, { ...validOutput.parts[1], category: "roof" }] }),
      "unexpected_category",
    ],
    [
      "duplicate category",
      JSON.stringify({ parts: [validOutput.parts[0], validOutput.parts[0]] }),
      "duplicate_category",
    ],
  ])("rejects %s", (_name, text, reason) => {
    const result = parseGeminiOutput(text, ["door", "wheel"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith(reason)).toBe(true);
  });
});

describe("extractText", () => {
  it("joins text parts and skips thought parts", () => {
    const body = {
      candidates: [
        { content: { parts: [{ text: "thinking", thought: true }, { text: "{\"a\":" }, { text: "1}" }] } },
      ],
    };
    expect(extractText(body)).toBe('{"a":1}');
  });

  it("returns null when there are no candidates", () => {
    expect(extractText({ promptFeedback: { blockReason: "SAFETY" } })).toBeNull();
  });
});

describe("buildGeminiRequest", () => {
  it("labels each category before its images", () => {
    const req = buildGeminiRequest(
      [
        { category: "door", images: [FAKE_IMAGE, FAKE_IMAGE] },
        { category: "wheel", images: [FAKE_IMAGE] },
      ],
      true,
    );
    const parts = req.contents[0]!.parts;
    expect(parts).toEqual([
      { text: "Category: door" },
      { inline_data: { mime_type: "image/jpeg", data: FAKE_IMAGE } },
      { inline_data: { mime_type: "image/jpeg", data: FAKE_IMAGE } },
      { text: "Category: wheel" },
      { inline_data: { mime_type: "image/jpeg", data: FAKE_IMAGE } },
    ]);
    expect(req.generationConfig).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
    expect(req.generationConfig.responseJsonSchema).toBeDefined();
  });

  it("omits the response schema when asked", () => {
    const req = buildGeminiRequest([{ category: "door", images: [FAKE_IMAGE] }], false);
    expect(req.generationConfig.responseJsonSchema).toBeUndefined();
  });
});

describe("assessWithGemini", () => {
  const input = [
    { category: "door" as const, images: [FAKE_IMAGE] },
    { category: "wheel" as const, images: [FAKE_IMAGE] },
  ];
  const options = { apiKey: "test-key", model: "test-model" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns parts on the first valid response and sends the API key header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(validOutput))));
    const parts = await assessWithGemini(input, options);
    expect(parts.map((p) => p.score)).toEqual([60, 30]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent",
    );
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
  });

  it("retries once after malformed JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope("{oops")))
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(validOutput))));
    const parts = await assessWithGemini(input, options);
    expect(parts).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once after a schema mismatch", async () => {
    const bad = { parts: [{ ...validOutput.parts[0], score: "high" }, validOutput.parts[1]] };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(bad))))
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(validOutput))));
    await expect(assessWithGemini(input, options)).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws AiFailedError after two invalid responses", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope("{oops")))
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify({ parts: [] }))));
    await expect(assessWithGemini(input, options)).rejects.toBeInstanceOf(AiFailedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after an HTTP error and throws if both fail", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 503));
    await expect(assessWithGemini(input, options)).rejects.toBeInstanceOf(AiFailedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops the response schema on retry after HTTP 400", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 400))
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(validOutput))));
    await assessWithGemini(input, options);
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(first.generationConfig.responseJsonSchema).toBeDefined();
    expect(second.generationConfig.responseJsonSchema).toBeUndefined();
  });

  it("retries after a network error", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(validOutput))));
    await expect(assessWithGemini(input, options)).resolves.toHaveLength(2);
  });

  it("never logs image data or the API key", async () => {
    const logSpy = vi.mocked(console.log);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope("{oops")))
      .mockResolvedValueOnce(jsonResponse(geminiEnvelope(JSON.stringify(validOutput))));
    await assessWithGemini(input, options);
    const logged = logSpy.mock.calls.flat().join("\n");
    expect(logged).not.toContain(FAKE_IMAGE);
    expect(logged).not.toContain("test-key");
  });
});
