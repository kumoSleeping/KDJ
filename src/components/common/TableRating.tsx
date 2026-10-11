import { useRef, type KeyboardEvent } from "react";

/**
 * A row's rating: five stars drawn by one element (design.css, `.kd-table-rating`): the outline
 * of all five under the filled ones up to the rating. One box, two masks, no SVG and no button
 * per star — a list has thousands of these, and every one of them is painted on every scroll.
 * The pointer picks a star by where it is; the keyboard steps the rating; a click on the star
 * that is the rating clears it, as before.
 */
export function TableRating({
  value,
  onChange,
}: {
  value: number;
  onChange?: (rating: number) => void;
}) {
  const rating = Math.max(0, Math.min(5, Math.round(value)));
  const ref = useRef<HTMLSpanElement>(null);
  const starAt = (event: { currentTarget: HTMLElement; clientX: number }) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.max(1, Math.min(5, Math.ceil(((event.clientX - box.left) / box.width) * 5)));
  };
  const onKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!onChange) return;
    const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? Math.min(5, rating + 1)
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? Math.max(0, rating - 1)
        : event.key === "Home" || event.key === "Delete" || event.key === "Backspace" ? 0
          : event.key === "End" ? 5
            : /^[0-5]$/.test(event.key) ? Number(event.key) : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== rating) onChange(next);
  };
  return (
    <span
      ref={ref}
      className="kd-table-rating"
      role={onChange ? "slider" : "img"}
      tabIndex={onChange ? 0 : undefined}
      aria-label="评分"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={rating}
      aria-valuetext={`${rating} 星`}
      title={rating ? `${rating} 星；点同一颗星清除评分` : "评分"}
      data-static={onChange ? undefined : "true"}
      draggable={false}
      style={{ "--kd-rating": rating } as React.CSSProperties}
      onPointerMove={onChange ? (event) => { ref.current?.style.setProperty("--kd-rating-shown", String(starAt(event))); } : undefined}
      onPointerLeave={onChange ? () => { ref.current?.style.removeProperty("--kd-rating-shown"); } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (!onChange) return;
        const star = starAt(event);
        onChange(rating === star ? 0 : star);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={onKey}
    />
  );
}
