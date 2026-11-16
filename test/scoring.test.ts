import { describe, expect, it } from "vitest";
import { DISCLAIMER } from "../src/config";
import {
  buildAssessResponse,
  computeOverallScore,
  labelForScore,
  partWeight,
  rankServices,
} from "../src/scoring";
import { part } from "./helpers";

describe("partWeight", () => {
  it("uses the configured category weights", () => {
    expect(partWeight({ category: "door", photoQuality: "good" })).toBe(1);
    expect(partWeight({ category: "bonnet", photoQuality: "good" })).toBe(1);
    expect(partWeight({ category: "roof", photoQuality: "good" })).toBe(1);
    expect(partWeight({ category: "interior", photoQuality: "good" })).toBe(1);
    expect(partWeight({ category: "bumper", photoQuality: "good" })).toBe(0.8);
    expect(partWeight({ category: "boot", photoQuality: "good" })).toBe(0.8);
    expect(partWeight({ category: "wheel", photoQuality: "good" })).toBe(0.8);
    expect(partWeight({ category: "glass", photoQuality: "good" })).toBe(0.5);
  });

  it("halves the weight for poor photos", () => {
    expect(partWeight({ category: "door", photoQuality: "poor" })).toBe(0.5);
    expect(partWeight({ category: "glass", photoQuality: "poor" })).toBe(0.25);
  });
});

describe("computeOverallScore", () => {
  it("returns the score of a single part", () => {
    expect(computeOverallScore([part({ category: "wheel", score: 73 })])).toBe(73);
  });

  it("computes a weighted average", () => {
    // (1.0*80 + 0.5*20) / 1.5 = 60
    expect(
      computeOverallScore([
        part({ category: "door", score: 80 }),
        part({ category: "glass", score: 20 }),
      ]),
    ).toBe(60);
  });

  it("counts poor-photo parts at half weight", () => {
    // good door 1.0*90, poor bonnet 0.5*30 -> 105/1.5 = 70
    expect(
      computeOverallScore([
        part({ category: "door", score: 90 }),
        part({ category: "bonnet", score: 30, photoQuality: "poor" }),
      ]),
    ).toBe(70);
  });

  it("rounds to the nearest integer", () => {
    // (1.0*50 + 0.8*51) / 1.8 = 50.444 -> 50
    expect(
      computeOverallScore([part({ category: "door", score: 50 }), part({ category: "wheel", score: 51 })]),
    ).toBe(50);
    // (1.0*1 + 0.5*2) / 1.5 = 1.333 -> 1
    expect(
      computeOverallScore([part({ category: "door", score: 1 }), part({ category: "glass", score: 2 })]),
    ).toBe(1);
    // (1.0*10 + 1.0*11) / 2 = 10.5 -> 11
    expect(
      computeOverallScore([part({ category: "door", score: 10 }), part({ category: "roof", score: 11 })]),
    ).toBe(11);
  });

  it("throws on an empty list", () => {
    expect(() => computeOverallScore([])).toThrow();
  });
});

describe("labelForScore", () => {
  it.each([
    [0, "clean"],
    [20, "clean"],
    [21, "light"],
    [50, "light"],
    [51, "moderate"],
    [80, "moderate"],
    [81, "heavy"],
    [100, "heavy"],
  ] as const)("score %i is %s", (score, label) => {
    expect(labelForScore(score)).toBe(label);
  });
});

describe("rankServices", () => {
  it("dedupes and orders by how many parts need each service", () => {
    const ranked = rankServices([
      part({ category: "door", services: ["Ceramic coating", "Clay bar treatment"] }),
      part({ category: "bonnet", services: ["Clay bar treatment", "Wax or sealant"] }),
      part({ category: "roof", services: ["Clay bar treatment", "Wax or sealant"] }),
    ]);
    expect(ranked).toEqual(["Clay bar treatment", "Wax or sealant", "Ceramic coating"]);
  });

  it("breaks ties using the service menu order", () => {
    const ranked = rankServices([
      part({ category: "wheel", services: ["Wheel deep clean"] }),
      part({ category: "interior", services: ["Interior deep clean"] }),
      part({ category: "door", services: ["Exterior wash and decontamination"] }),
    ]);
    expect(ranked).toEqual([
      "Exterior wash and decontamination",
      "Wheel deep clean",
      "Interior deep clean",
    ]);
  });

  it("counts a service once per part even if repeated", () => {
    const ranked = rankServices([
      part({ category: "door", services: ["Ceramic coating", "Ceramic coating"] }),
      part({ category: "roof", services: ["Wax or sealant"] }),
      part({ category: "bonnet", services: ["Wax or sealant"] }),
    ]);
    expect(ranked).toEqual(["Wax or sealant", "Ceramic coating"]);
  });

  it("returns an empty list when no services are needed", () => {
    expect(rankServices([part({ category: "door" })])).toEqual([]);
  });
});

describe("buildAssessResponse", () => {
  it("assembles the full response", () => {
    const parts = [
      part({ category: "door", score: 85, services: ["Multi-stage paint correction"] }),
      part({ category: "wheel", score: 40, services: ["Wheel deep clean"] }),
    ];
    const res = buildAssessResponse(parts);
    // (85 + 0.8*40) / 1.8 = 65
    expect(res.overallScore).toBe(65);
    expect(res.overallLabel).toBe("moderate");
    expect(res.parts).toBe(parts);
    expect(res.recommendedServices).toEqual(["Multi-stage paint correction", "Wheel deep clean"]);
    expect(res.disclaimer).toBe(DISCLAIMER);
  });
});
