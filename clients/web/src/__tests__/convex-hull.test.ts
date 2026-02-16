import { describe, test, expect } from "bun:test";
import { convexHull, paddedHullPath } from "../lib/convex-hull";

// Mock Path2D for test environment
if (typeof Path2D === "undefined") {
  (globalThis as any).Path2D = class Path2D {
    moveTo(_x: number, _y: number) {}
    lineTo(_x: number, _y: number) {}
    arc(
      _x: number,
      _y: number,
      _radius: number,
      _startAngle: number,
      _endAngle: number,
    ) {}
    closePath() {}
  };
}

describe("convexHull", () => {
  test("empty points → empty hull", () => {
    expect(convexHull([])).toEqual([]);
  });

  test("single point → single point hull", () => {
    expect(convexHull([{ x: 5, y: 5 }])).toEqual([{ x: 5, y: 5 }]);
  });

  test("two points → both points", () => {
    const result = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(result.length).toBe(2);
  });

  test("square → 4 corner points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior point — excluded
    ];
    const result = convexHull(points);
    expect(result.length).toBe(4);
  });
});

describe("paddedHullPath", () => {
  test("returns a Path2D for canvas drawing", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const path = paddedHullPath(points, 5);
    expect(path).toBeInstanceOf(Path2D);
  });
});
