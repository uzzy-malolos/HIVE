import { useCallback, useEffect, useRef, useState } from "react";

export interface ResizeHandleProps {
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  minRatio?: number;
  maxRatio?: number;
  containerRef: React.RefObject<HTMLElement | null>;
}

export function ResizeHandle({
  splitRatio,
  onSplitRatioChange,
  minRatio = 0.25,
  maxRatio = 0.75,
  containerRef,
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setIsDragging(true);
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!isDragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const relativeX = event.clientX - rect.left;
      const rawRatio = relativeX / rect.width;
      const clampedRatio = Math.max(minRatio, Math.min(maxRatio, rawRatio));
      onSplitRatioChange(clampedRatio);
    },
    [isDragging, containerRef, minRatio, maxRatio, onSplitRatioChange],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (isDragging) {
        setIsDragging(false);
        try {
          (event.target as HTMLElement).releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
    },
    [isDragging],
  );

  const handleDoubleClick = useCallback(() => {
    onSplitRatioChange(0.4);
  }, [onSplitRatioChange]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onSplitRatioChange(Math.max(minRatio, splitRatio - 0.05));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onSplitRatioChange(Math.min(maxRatio, splitRatio + 0.05));
      } else if (event.key === "Home" || event.key === "Enter") {
        event.preventDefault();
        onSplitRatioChange(0.4);
      }
    },
    [splitRatio, minRatio, maxRatio, onSplitRatioChange],
  );

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(splitRatio * 100)}
      aria-valuemin={Math.round(minRatio * 100)}
      aria-valuemax={Math.round(maxRatio * 100)}
      aria-label="Resize Chat and Coder panes"
      tabIndex={0}
      className={`resize-handle ${isDragging ? "is-dragging" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="resize-handle-bar" />
    </div>
  );
}
