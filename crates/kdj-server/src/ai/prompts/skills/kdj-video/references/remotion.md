# 用 Remotion 渲染片段

Remotion 用 React 写画面，适合：标题和字卡、歌名/艺人的动态文字、图形与版式动画、形状遮罩、Lottie、three.js 视觉、
用 `@remotion/transitions` 做的转场。KDJ 在工作目录的 `remotion/` 里装好了 `remotion`、`@remotion/cli`、`@remotion/transitions`、
`react`、`react-dom`（设置 → AI → 视频）。没装时 `kdj_remotion_render` 会说明，让用户去装。

## 文件

用 `write` 写在 `remotion/src/`：

`remotion/src/index.ts`
```ts
import { registerRoot } from "remotion";
import { Root } from "./Root";
registerRoot(Root);
```

`remotion/src/Root.tsx`
```tsx
import { Composition } from "remotion";
import { Title } from "./Title";
export const Root = () => (
  <Composition id="Title" component={Title} durationInFrames={120} fps={30} width={1920} height={1080}
    defaultProps={{ text: "Set A" }} />
);
```

`remotion/src/Title.tsx`
```tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
export const Title = ({ text }: { text: string }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const leave = interpolate(frame, [durationInFrames - 15, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: leave }}>
      <h1 style={{ color: "white", fontSize: 140, fontFamily: "sans-serif", transform: `scale(${0.8 + 0.2 * enter})` }}>{text}</h1>
    </AbsoluteFill>
  );
};
```

然后：`kdj_remotion_render({ entry: "src/index.ts", composition: "Title", output: "title.mov", props: { text: "Set A" },
args: ["--codec=prores", "--prores-profile=4444", "--pixel-format=yuva444p10le", "--image-format=png"] })` —— 透明背景（不给 AbsoluteFill 背景色）
就能盖在 .kdjv 的上层轨道；要不透明的普通片段直接输出 `.mp4`（默认 h264）。

## 要点

- 尺寸、帧率和工程画布一致；`durationInFrames` = 秒 × fps。
- 时间都从 `useCurrentFrame()` 算，不要用 `setTimeout`、CSS 动画或 `Date.now()`——渲染是逐帧截图的。
- 遮罩：`style={{ clipPath: "circle(40% at 50% 50%)" }}` 或 CSS `mask-image`；用 `interpolate` 让 clipPath 的半径随帧变化，
  做圆形展开、擦除等遮罩转场。
- 转场：`import { TransitionSeries, linearTiming } from "@remotion/transitions"`，配 `fade()`（`@remotion/transitions/fade`）、
  `slide()`、`wipe()`、`flip()`、`clockWipe()`；在两段之间 `<TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: 20})} />`。
- 用本地视频/图片做素材：`<OffthreadVideo src={staticFile("x.mp4")} />` 需要把文件放进 `remotion/public/`——更简单的做法是
  只用 Remotion 做透明的上层（字、图形、遮罩），底下的视频交给 .kdjv 的下层轨道。
- 渲染失败时看返回的最后几行，改代码再渲染。
