import { Star } from "lucide-react";

export function TableRating({
  value,
  onChange,
}: {
  value: number;
  onChange?: (rating: number) => void;
}) {
  const rating = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span className="kd-table-rating" role="group" aria-label={`当前评分 ${rating} 星`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          draggable={false}
          disabled={!onChange}
          aria-label={`${star} 星`}
          title={`${star} 星${rating === star ? "；再次点击清除评分" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onChange?.(rating === star ? 0 : star);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Star size={11} fill={star <= rating ? "currentColor" : "none"} />
        </button>
      ))}
    </span>
  );
}
