import { describe, expect, it } from "vitest";

import { isValidLocale, pathFromSegments } from "./normalize-path";

describe("pathFromSegments", () => {
  it("returns empty string for home (no segments)", () => {
    expect(pathFromSegments(undefined)).toBe("");
    expect(pathFromSegments([])).toBe("");
  });

  it("joins single and nested segments without leading slash", () => {
    expect(pathFromSegments(["about"])).toBe("about");
    expect(pathFromSegments(["services", "ent"])).toBe("services/ent");
  });

  it("drops empty parts", () => {
    expect(pathFromSegments(["a", "", "b"])).toBe("a/b");
  });
});

describe("isValidLocale", () => {
  it("accepts el and ru only", () => {
    expect(isValidLocale("el")).toBe(true);
    expect(isValidLocale("ru")).toBe(true);
    expect(isValidLocale("en")).toBe(false);
  });
});
