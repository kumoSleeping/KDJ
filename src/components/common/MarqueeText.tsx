import { useEffect, useRef, useState, type CSSProperties } from "react";

const MARQUEE_SPEED = 40;
// Each leg occupies 35% of kd-marquee; the remaining time pauses at the ends.
const MARQUEE_TRAVEL = .35;

/** Measure actual overflow so short text stays still and long text reaches its end. */
export function MarqueeText({ className, text }: { className: string; text: string }) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let alive = true;
    const measure = () => {
      if (!alive || !box.clientWidth) return;
      // Measuring the inner span avoids ellipsis changing the outer scrollWidth.
      const content = box.firstElementChild as HTMLElement | null;
      const over = (content?.scrollWidth ?? box.scrollWidth) - box.clientWidth;
      setShift(over > 1 ? over : 0);
    };
    measure();
    // System CJK font fallback can settle after layout without firing a font event.
    const frame = requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 400);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [text]);

  const style = shift ? {
    "--kd-marquee-shift": `${-shift}px`,
    "--kd-marquee-time": `${Math.max(4, shift / (MARQUEE_SPEED * MARQUEE_TRAVEL)).toFixed(1)}s`,
  } as CSSProperties : undefined;

  return <span ref={boxRef} className={`kd-marquee-viewport ${className}`} title={text}
    data-marquee={shift ? "true" : undefined} style={style}>
    <span key={text} className="kd-marquee">{text}</span>
  </span>;
}
