import { describe, expect, it } from "vitest";
import { AssessRequestSchema, AssessResponseSchema, PartResultSchema } from "../src/schema";
import { FAKE_IMAGE } from "./helpers";

const validRequest = {
  turnstileToken: "token",
  parts: [
    { category: "door", images: [FAKE_IMAGE, FAKE_IMAGE] },
    { category: "wheel", images: [FAKE_IMAGE] },
  ],
};

describe("AssessRequestSchema", () => {
  it("accepts a valid request", () => {
    expect(AssessRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("accepts a request without a turnstile token", () => {
    const { turnstileToken: _omit, ...noToken } = validRequest;
    expect(AssessRequestSchema.safeParse(noToken).success).toBe(true);
  });

  it("accepts all 8 categories with 4 images each", () => {
    const parts = ["door", "wheel", "bonnet", "roof", "bumper", "boot", "glass", "interior"].map(
      (category) => ({ category, images: Array(4).fill(FAKE_IMAGE) }),
    );
    expect(AssessRequestSchema.safeParse({ turnstileToken: "t", parts }).success).toBe(true);
  });

  it("rejects duplicate categories", () => {
    const result = AssessRequestSchema.safeParse({
      turnstileToken: "t",
      parts: [
        { category: "door", images: [FAKE_IMAGE] },
        { category: "door", images: [FAKE_IMAGE] },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message === "Duplicate categories")).toBe(true);
  });

  it.each([
    ["missing token", { ...validRequest, turnstileToken: "" }],
    ["no parts", { ...validRequest, parts: [] }],
    ["unknown category", { ...validRequest, parts: [{ category: "engine", images: [FAKE_IMAGE] }] }],
    ["no images", { ...validRequest, parts: [{ category: "door", images: [] }] }],
    ["too many images", { ...validRequest, parts: [{ category: "door", images: Array(5).fill(FAKE_IMAGE) }] }],
    ["image too short", { ...validRequest, parts: [{ category: "door", images: ["abc"] }] }],
    [
      "too many parts",
      {
        ...validRequest,
        parts: Array.from({ length: 9 }, () => ({ category: "door", images: [FAKE_IMAGE] })),
      },
    ],
    ["not an object", "hello"],
  ])("rejects %s", (_name, body) => {
    expect(AssessRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("PartResultSchema", () => {
  const valid = { category: "door", score: 42, issues: ["Swirl marks"], services: [], photoQuality: "good" };

  it("accepts a valid part", () => {
    expect(PartResultSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["non-integer score", { ...valid, score: 42.5 }],
    ["score above 100", { ...valid, score: 101 }],
    ["negative score", { ...valid, score: -1 }],
    ["more than 6 issues", { ...valid, issues: Array(7).fill("x") }],
    ["bad photoQuality", { ...valid, photoQuality: "ok" }],
    ["missing services", { ...valid, services: undefined }],
  ])("rejects %s", (_name, body) => {
    expect(PartResultSchema.safeParse(body).success).toBe(false);
  });
});

describe("AssessResponseSchema", () => {
  it("rejects an unknown label", () => {
    expect(
      AssessResponseSchema.safeParse({
        overallScore: 10,
        overallLabel: "spotless",
        parts: [],
        recommendedServices: [],
        disclaimer: "x",
      }).success,
    ).toBe(false);
  });
});
