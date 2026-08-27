import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type WheelEvent } from "react";

import "./image-viewer.css";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const SCALE_STEP = 0.5;

type Point = Readonly<{ x: number; y: number }>;

export function ImageViewer({
  src,
  alt,
}: Readonly<{
  src: string;
  alt: string;
}>): ReactElement {
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const previousPinchDistance = useRef<number | null>(null);
  const previousDragPoint = useRef<Point | null>(null);

  const reset = useCallback(() => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
    pointers.current.clear();
    previousPinchDistance.current = null;
    previousDragPoint.current = null;
  }, []);

  useEffect(() => reset(), [reset, src]);

  const updateScale = useCallback((nextScale: number) => {
    const boundedScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    setScale(boundedScale);
    if (boundedScale === MIN_SCALE) setOffset({ x: 0, y: 0 });
  }, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    updateScale(scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    previousDragPoint.current = point;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const activePointers = [...pointers.current.values()];

    if (activePointers.length >= 2) {
      const first = activePointers[0]!;
      const second = activePointers[1]!;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const previousDistance = previousPinchDistance.current;
      if (previousDistance) updateScale(scale * (distance / previousDistance));
      previousPinchDistance.current = distance;
      previousDragPoint.current = null;
      return;
    }

    previousPinchDistance.current = null;
    const previousPoint = previousDragPoint.current;
    if (scale > MIN_SCALE && previousPoint) {
      setOffset((current) => ({
        x: current.x + point.x - previousPoint.x,
        y: current.y + point.y - previousPoint.y,
      }));
    }
    previousDragPoint.current = point;
  };

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    previousPinchDistance.current = null;
    previousDragPoint.current = pointers.current.size === 1 ? [...pointers.current.values()][0] ?? null : null;
  };

  return <div className="image-viewer">
    <div className="image-viewer__controls" aria-label="图片缩放工具">
      <button type="button" aria-label="缩小图片" disabled={scale <= MIN_SCALE} onClick={() => updateScale(scale - SCALE_STEP)}>−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button type="button" aria-label="放大图片" disabled={scale >= MAX_SCALE} onClick={() => updateScale(scale + SCALE_STEP)}>＋</button>
      <button type="button" disabled={scale === MIN_SCALE && offset.x === 0 && offset.y === 0} onClick={reset}>还原</button>
    </div>
    <div
      className={`image-viewer__viewport${scale > MIN_SCALE ? " image-viewer__viewport--zoomed" : ""}`}
      onWheel={handleWheel}
      onDoubleClick={() => updateScale(scale === MIN_SCALE ? 2 : MIN_SCALE)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      aria-label="图片查看区；可滚轮、双击或双指缩放"
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
      />
    </div>
  </div>;
}
