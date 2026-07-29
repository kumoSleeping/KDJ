import { useEffect, useRef } from "react";

export type SearchBurstTone = "rainbow" | "pink";

/**
 * 搜索提交瞬间的炫彩竖向波形柱 + 少量横向细波线。
 * 左→右推进；不要前缘那条竖向电弧线。
 */
export function SearchBurstFX({ tone }: { tone: SearchBurstTone }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const duration = tone === "pink" ? 980 : 860;
    const start = performance.now();
    let raf = 0;

    type Particle = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      max: number;
      r: number;
      hue: number;
    };
    const particles: Particle[] = [];

    const colorAt = (u: number, alpha: number): string => {
      if (tone === "pink") {
        const hues = [330, 340, 350, 320, 300];
        const h = hues[Math.floor(u * (hues.length - 1))];
        return `hsla(${h}, 95%, ${58 + u * 18}%, ${alpha})`;
      }
      const h = 350 + u * 280;
      return `hsla(${h % 360}, 92%, ${52 + Math.sin(u * Math.PI) * 12}%, ${alpha})`;
    };

    const hueAt = (u: number): number =>
      tone === "pink" ? 320 + u * 40 : (350 + u * 280) % 360;

    const spawn = (x: number, y: number, w: number, u: number) => {
      if (particles.length > 90) return;
      particles.push({
        x,
        y,
        vx: (0.4 + Math.random() * 1.6) * (w / 420),
        vy: (Math.random() - 0.55) * 1.8,
        life: 0,
        max: 280 + Math.random() * 420,
        r: 0.8 + Math.random() * 2.2,
        hue: hueAt(u),
      });
    };

    /** 横向细波：大振幅、低频，叠在竖柱之上。 */
    const horizY = (x: number, time: number, phase: number, mid: number, amp: number): number =>
      mid +
      amp *
        (0.7 * Math.sin(x * 0.014 + time * 1.15 + phase) +
          0.3 * Math.sin(x * 0.033 - time * 2.1 + phase * 1.6));

    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - (1 - t) ** 2.4;
      const fade = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;

      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      ctx.clearRect(0, 0, w, h);

      const front = w * ease;
      const barW = 2.4;
      const gap = 1.1;
      const step = barW + gap;
      const mid = h * 0.5;
      const time = now * 0.006;

      // 底层柔光扫带
      const glow = ctx.createLinearGradient(0, 0, front, 0);
      for (let i = 0; i <= 6; i++) {
        const u = i / 6;
        glow.addColorStop(u, colorAt(u * ease, 0.14 * fade));
      }
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, front, h);

      // 竖向炫彩波形柱
      for (let x = 0; x < front; x += step) {
        const u = x / Math.max(1, w);
        const local = x / Math.max(1, front);
        const wave =
          0.42 * Math.sin(x * 0.085 + time * 2.1) +
          0.28 * Math.sin(x * 0.17 - time * 3.4) +
          0.18 * Math.sin(x * 0.31 + time * 1.3) +
          0.12 * Math.sin(x * 0.055 + time * 0.7);
        const envelope = Math.sin(local * Math.PI) ** 0.55;
        const leadBoost = Math.max(0, 1 - (front - x) / 28) * 0.55;
        const amp = (0.22 + Math.abs(wave) * 0.62 + leadBoost) * envelope;
        const bh = Math.max(2, amp * h * 0.92);
        const by = mid - bh / 2;

        const alpha = (0.55 + leadBoost * 0.4) * fade;
        ctx.fillStyle = colorAt(u, alpha);

        const r = Math.min(barW / 2, bh / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, by);
        ctx.arcTo(x + barW, by, x + barW, by + bh, r);
        ctx.arcTo(x + barW, by + bh, x, by + bh, r);
        ctx.arcTo(x, by + bh, x, by, r);
        ctx.arcTo(x, by, x + barW, by, r);
        ctx.closePath();
        ctx.fill();

        if (Math.random() < 0.08 + leadBoost * 0.25) {
          spawn(x + barW / 2, by + Math.random() * 3, w, u);
        }
        if (Math.random() < 0.04 + leadBoost * 0.15) {
          spawn(x + barW / 2, by + bh - Math.random() * 3, w, u);
        }
      }

      // 两条横向细波线（叠在竖柱上），不要竖向前缘电弧
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const horizLayers = [
        { phase: 0.2, amp: h * 0.38, width: 1.05, alpha: 0.72 },
        { phase: 2.4, amp: h * 0.3, width: 0.75, alpha: 0.48 },
      ];
      for (const layer of horizLayers) {
        const seg = 10;
        for (let x0 = 0; x0 < front; x0 += seg) {
          const x1 = Math.min(front, x0 + seg + 1);
          const u = ((x0 + x1) * 0.5) / Math.max(1, w);
          ctx.beginPath();
          ctx.lineWidth = layer.width;
          ctx.strokeStyle = colorAt(u, layer.alpha * fade);
          let first = true;
          for (let x = x0; x <= x1; x += 1) {
            const y = horizY(x, time, layer.phase, mid, layer.amp);
            if (first) {
              ctx.moveTo(x, y);
              first = false;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        }
      }
      ctx.restore();

      // 粒子
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += 16;
        p.x += p.vx;
        p.y += p.vy;
        p.vy -= 0.015;
        const lifeT = p.life / p.max;
        if (lifeT >= 1 || p.x > w + 4) {
          particles.splice(i, 1);
          continue;
        }
        const a = (1 - lifeT) * fade * 0.95;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${p.hue}, 95%, 68%, ${a})`;
        ctx.arc(p.x, p.y, p.r * (1 - lifeT * 0.4), 0, Math.PI * 2);
        ctx.fill();
        if (p.r > 1.4) {
          ctx.strokeStyle = `hsla(${p.hue}, 100%, 80%, ${a * 0.5})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(p.x - p.r * 2, p.y);
          ctx.lineTo(p.x + p.r * 2, p.y);
          ctx.moveTo(p.x, p.y - p.r * 2);
          ctx.lineTo(p.x, p.y + p.r * 2);
          ctx.stroke();
        }
      }

      // 上下边缘淡回面板
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      const edge = ctx.createLinearGradient(0, 0, 0, h);
      edge.addColorStop(0, "rgba(0,0,0,0.95)");
      edge.addColorStop(0.18, "rgba(0,0,0,0.35)");
      edge.addColorStop(0.35, "rgba(0,0,0,0)");
      edge.addColorStop(0.65, "rgba(0,0,0,0)");
      edge.addColorStop(0.82, "rgba(0,0,0,0.35)");
      edge.addColorStop(1, "rgba(0,0,0,0.95)");
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      if (t < 1) raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tone]);

  return <canvas ref={canvasRef} className="kd-search-burst-fx" aria-hidden="true" />;
}
