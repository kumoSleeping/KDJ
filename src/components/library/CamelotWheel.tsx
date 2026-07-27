import { useMemo } from "react";
import { camelotColor, camelotNeighbours, camelotToLabel, parseCamelot } from "../../lib/camelot";

export interface CamelotWheelProps {
  /** 当前曲目的 Camelot 码，如 "8A"；空 = 未分析，整轮变灰。 */
  code: string;
  size?: number;
  /** 点某个扇区（一般用来按调筛选曲库）。 */
  onPick?(code: string): void;
}

const RING_OUTER = 1; // 外圈 = B（大调）
const RING_INNER = 0; // 内圈 = A（小调）

interface Segment {
  code: string;
  path: string;
  labelX: number;
  labelY: number;
}

/** 环形扇区路径。角度以 12 点方向为 0，顺时针增长（和实体调号轮一致）。 */
function sectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const point = (radius: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)] as const;
  };
  const [x0, y0] = point(rOuter, startDeg);
  const [x1, y1] = point(rOuter, endDeg);
  const [x2, y2] = point(rInner, endDeg);
  const [x3, y3] = point(rInner, startDeg);
  // 每段只有 30°，永远是小弧，large-arc-flag 固定 0
  return [
    `M ${x0} ${y0}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${rInner} ${rInner} 0 0 0 ${x3} ${y3}`,
    "Z",
  ].join(" ");
}

export function CamelotWheel({ code, size = 220, onPick }: CamelotWheelProps) {
  const current = parseCamelot(code);
  const neighbours = useMemo(() => new Set(camelotNeighbours(code)), [code]);

  const segments = useMemo(() => {
    const cx = size / 2;
    const cy = size / 2;
    const rings = [
      { ring: RING_INNER, letter: "A", inner: size * 0.16, outer: size * 0.3 },
      { ring: RING_OUTER, letter: "B", inner: size * 0.32, outer: size * 0.47 },
    ];
    const result: Segment[] = [];
    for (const { letter, inner, outer } of rings) {
      for (let n = 1; n <= 12; n += 1) {
        const start = (n - 1) * 30 - 15;
        const end = start + 30;
        const mid = ((start + end) / 2 - 90) * (Math.PI / 180);
        const radius = (inner + outer) / 2;
        result.push({
          code: `${n}${letter}`,
          path: sectorPath(cx, cy, inner, outer, start + 1, end - 1),
          labelX: cx + radius * Math.cos(mid),
          labelY: cy + radius * Math.sin(mid),
        });
      }
    }
    return result;
  }, [size]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={current ? `调号轮，当前 ${code}` : "调号轮，当前曲目未分析"}
    >
      {segments.map((segment) => {
        const isCurrent = current !== null && segment.code === code;
        const isNeighbour = neighbours.has(segment.code);
        const accent = camelotColor(segment.code);
        const fill = isCurrent
          ? `color-mix(in oklab, ${accent} 38%, var(--kd-panel))`
          : isNeighbour
            ? `color-mix(in oklab, ${accent} 24%, var(--kd-panel))`
            : "var(--kd-panel-inset)";
        return (
          <g
            key={segment.code}
            onClick={onPick ? () => onPick(segment.code) : undefined}
            style={onPick ? { cursor: "pointer" } : undefined}
          >
            <title>{`${segment.code} · ${camelotToLabel(segment.code)}`}</title>
            <path
              d={segment.path}
              fill={fill}
              stroke={
                isCurrent
                  ? `color-mix(in oklab, ${accent} 72%, var(--kd-line))`
                  : "var(--kd-line)"
              }
              strokeWidth={isCurrent ? 2 : 1}
              opacity={isCurrent || isNeighbour ? 1 : 0.55}
            />
            <text
              x={segment.labelX}
              y={segment.labelY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={size * 0.045}
              fontWeight={isCurrent ? 800 : 600}
              fill={isCurrent || isNeighbour ? "var(--kd-text)" : "var(--kd-faint)"}
              style={{ pointerEvents: "none", fontVariantNumeric: "tabular-nums" }}
            >
              {segment.code}
            </text>
          </g>
        );
      })}

      <text
        x={size / 2}
        y={size / 2 - size * 0.03}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.09}
        fontWeight={800}
        fill="var(--kd-text)"
      >
        {current ? code : "—"}
      </text>
      <text
        x={size / 2}
        y={size / 2 + size * 0.06}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.042}
        fill="var(--kd-muted)"
      >
        {current ? camelotToLabel(code) : "未分析"}
      </text>
    </svg>
  );
}
