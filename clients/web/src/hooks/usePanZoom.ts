import { useRef, useCallback, useEffect, useState } from "react";

interface PanZoomState {
  tx: number;
  ty: number;
  scale: number;
}

interface UsePanZoomOptions {
  minScale?: number;
  maxScale?: number;
}

export function usePanZoom(options: UsePanZoomOptions = {}) {
  const { minScale = 0.1, maxScale = 3 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<PanZoomState>({ tx: 0, ty: 0, scale: 1 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const [scale, setScale] = useState(1); // for UI display only

  // Pinch-to-zoom state
  const pinchRef = useRef<{ startDist: number; startScale: number; midX: number; midY: number } | null>(null);

  const applyTransform = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const { tx, ty, scale } = stateRef.current;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    el.style.transformOrigin = "0 0";
  }, []);

  const zoomToFit = useCallback(
    (totalWidth: number, totalHeight: number, padding = 40) => {
      const container = containerRef.current;
      if (!container || totalWidth === 0 || totalHeight === 0) return;
      const rect = container.getBoundingClientRect();
      const scaleX = (rect.width - padding * 2) / totalWidth;
      const scaleY = (rect.height - padding * 2) / totalHeight;
      const newScale = Math.min(scaleX, scaleY, 1); // don't zoom in past 100%
      const clampedScale = Math.max(minScale, Math.min(maxScale, newScale));
      stateRef.current = {
        tx: (rect.width - totalWidth * clampedScale) / 2,
        ty: (rect.height - totalHeight * clampedScale) / 2,
        scale: clampedScale,
      };
      setScale(clampedScale);
      applyTransform();
    },
    [applyTransform, minScale, maxScale],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Prevent browser gestures on the pan/zoom area
    container.style.touchAction = "none";

    // --- Mouse events ---

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const { tx, ty, scale: oldScale } = stateRef.current;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(minScale, Math.min(maxScale, oldScale * factor));

      // Zoom centered on cursor
      stateRef.current = {
        tx: mouseX - (mouseX - tx) * (newScale / oldScale),
        ty: mouseY - (mouseY - ty) * (newScale / oldScale),
        scale: newScale,
      };
      setScale(newScale);
      applyTransform();
    };

    const onMouseDown = (e: MouseEvent) => {
      // Only pan on left-click on empty space (not on nodes)
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-dag-node]")) return;
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        tx: stateRef.current.tx,
        ty: stateRef.current.ty,
      };
      container.style.cursor = "grabbing";
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      stateRef.current.tx = panStartRef.current.tx + dx;
      stateRef.current.ty = panStartRef.current.ty + dy;
      applyTransform();
    };

    const onMouseUp = () => {
      isPanningRef.current = false;
      container.style.cursor = "";
    };

    // --- Touch events ---

    function touchDist(a: Touch, b: Touch): number {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        // Start pinch-to-zoom
        e.preventDefault();
        isPanningRef.current = false;
        const t0 = e.touches[0]!;
        const t1 = e.touches[1]!;
        const rect = container.getBoundingClientRect();
        pinchRef.current = {
          startDist: touchDist(t0, t1),
          startScale: stateRef.current.scale,
          midX: (t0.clientX + t1.clientX) / 2 - rect.left,
          midY: (t0.clientY + t1.clientY) / 2 - rect.top,
        };
      } else if (e.touches.length === 1) {
        // Single-finger pan (skip if touching a node)
        if ((e.target as HTMLElement).closest("[data-dag-node]")) return;
        e.preventDefault();
        const t = e.touches[0]!;
        isPanningRef.current = true;
        pinchRef.current = null;
        panStartRef.current = {
          x: t.clientX,
          y: t.clientY,
          tx: stateRef.current.tx,
          ty: stateRef.current.ty,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const t0 = e.touches[0]!;
        const t1 = e.touches[1]!;
        const newDist = touchDist(t0, t1);
        const ratio = newDist / pinchRef.current.startDist;
        const oldScale = stateRef.current.scale;
        const newScale = Math.max(
          minScale,
          Math.min(maxScale, pinchRef.current.startScale * ratio),
        );

        const { midX, midY } = pinchRef.current;
        const { tx, ty } = stateRef.current;
        stateRef.current = {
          tx: midX - (midX - tx) * (newScale / oldScale),
          ty: midY - (midY - ty) * (newScale / oldScale),
          scale: newScale,
        };
        setScale(newScale);
        applyTransform();
      } else if (e.touches.length === 1 && isPanningRef.current) {
        e.preventDefault();
        const t = e.touches[0]!;
        const dx = t.clientX - panStartRef.current.x;
        const dy = t.clientY - panStartRef.current.y;
        stateRef.current.tx = panStartRef.current.tx + dx;
        stateRef.current.ty = panStartRef.current.ty + dy;
        applyTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchRef.current = null;
      }
      if (e.touches.length === 0) {
        isPanningRef.current = false;
      }
      // Transition from pinch back to single-finger pan
      if (e.touches.length === 1 && !pinchRef.current) {
        const t = e.touches[0]!;
        isPanningRef.current = true;
        panStartRef.current = {
          x: t.clientX,
          y: t.clientY,
          tx: stateRef.current.tx,
          ty: stateRef.current.ty,
        };
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
    };
  }, [applyTransform, minScale, maxScale]);

  return { containerRef, contentRef, scale, zoomToFit, stateRef };
}
