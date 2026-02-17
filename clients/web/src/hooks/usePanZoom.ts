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

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [applyTransform, minScale, maxScale]);

  return { containerRef, contentRef, scale, zoomToFit, stateRef };
}
