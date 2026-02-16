export interface Point {
  x: number;
  y: number;
}

/**
 * Compute the convex hull of a set of 2D points using Graham scan.
 * Returns points in counter-clockwise order.
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return [...points];

  // Find lowest y (leftmost tiebreak)
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  const pivot = sorted[0]!;

  // Sort by polar angle from pivot
  const rest = sorted.slice(1).sort((a, b) => {
    const angleA = Math.atan2(a.y - pivot.y, a.x - pivot.x);
    const angleB = Math.atan2(b.y - pivot.y, b.x - pivot.x);
    if (angleA !== angleB) return angleA - angleB;
    const distA = (a.x - pivot.x) ** 2 + (a.y - pivot.y) ** 2;
    const distB = (b.x - pivot.x) ** 2 + (b.y - pivot.y) ** 2;
    return distA - distB;
  });

  const stack: Point[] = [pivot];
  for (const p of rest) {
    while (stack.length >= 2) {
      const a = stack[stack.length - 2]!;
      const b = stack[stack.length - 1]!;
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cross <= 0) stack.pop();
      else break;
    }
    stack.push(p);
  }

  return stack;
}

/**
 * Create a padded, rounded Path2D from hull points for canvas drawing.
 */
export function paddedHullPath(points: Point[], padding: number): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;

  if (points.length === 1) {
    const p = points[0]!;
    path.arc(p.x, p.y, padding, 0, Math.PI * 2);
    return path;
  }

  if (points.length === 2) {
    const [a, b] = points as [Point, Point];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = (-dy / len) * padding;
    const ny = (dx / len) * padding;
    const angle = Math.atan2(dy, dx);

    path.moveTo(a.x + nx, a.y + ny);
    path.lineTo(b.x + nx, b.y + ny);
    path.arc(b.x, b.y, padding, angle - Math.PI / 2, angle + Math.PI / 2);
    path.lineTo(a.x - nx, a.y - ny);
    path.arc(a.x, a.y, padding, angle + Math.PI / 2, angle + Math.PI * 1.5);
    path.closePath();
    return path;
  }

  // Offset each edge outward by padding, then connect with arcs at corners
  const hull = convexHull(points);
  const n = hull.length;

  for (let i = 0; i < n; i++) {
    const curr = hull[i]!;
    const next = hull[(i + 1) % n]!;
    const prev = hull[(i - 1 + n) % n]!;

    const dx1 = next.x - curr.x;
    const dy1 = next.y - curr.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

    const nx1 = (-dy1 / len1) * padding;
    const ny1 = (dx1 / len1) * padding;

    const angleIn = Math.atan2(curr.y - prev.y, curr.x - prev.x) - Math.PI / 2;
    const angleOut = Math.atan2(dy1, dx1) - Math.PI / 2;

    if (i === 0) {
      path.moveTo(curr.x + nx1, curr.y + ny1);
    } else {
      path.arc(curr.x, curr.y, padding, angleIn, angleOut);
    }

    path.lineTo(next.x + nx1, next.y + ny1);
  }

  const first = hull[0]!;
  const last = hull[n - 1]!;
  const dx = first.x - last.x;
  const dy = first.y - last.y;
  const angleIn = Math.atan2(dy, dx) - Math.PI / 2;
  const dxFirst = hull[1]!.x - first.x;
  const dyFirst = hull[1]!.y - first.y;
  const angleOut = Math.atan2(dyFirst, dxFirst) - Math.PI / 2;
  path.arc(first.x, first.y, padding, angleIn, angleOut);
  path.closePath();

  return path;
}
