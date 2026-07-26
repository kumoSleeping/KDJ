import { Download, Minus, Moon, Square, Sun, X } from "lucide-react";
import { Button } from "../common";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";

/**
 * 标题栏 = 品牌 + 下载状态 + 日夜切换。
 *
 * 没有板块导航，因为已经没有板块了：曲库和搜索下载在同一个工作台上，
 * 顶上那条搜索框一搜就切到结果、关掉就回曲库。设置收在左下角。
 * 品牌处不用红色：红色留给"需要被找到"的东西，标题不属于那一类。
 */
export function TitleBar() {
  const active = useDownloadStore((state) => state.activeCount);
  const theme = useAppStore((state) => state.settings?.theme ?? "dark");
  const saveSettings = useAppStore((state) => state.saveSettings);

  // theme=system 时按当前实际生效的那个取反，点一下就能立刻看到变化
  const resolved = theme === "system" ? (document.documentElement.dataset.theme ?? "dark") : theme;
  const isDark = resolved !== "light";

  // macOS 用 hiddenInset 标题栏，红绿灯是系统画的（.kd-titlebar 左侧已留出 84px），
  // 自绘一套只会重影，所以只有非 mac 才渲染窗口按钮。
  const isMac = window.kumodeck?.platform === "darwin";
  const control = (action: "minimize" | "maximize" | "close") => () => {
    window.kumodeck?.windowControl(action);
  };

  return (
    <header className="kd-titlebar">
      <div className="kd-titlebar-brand">KumoDeck</div>

      {/* 下载在跑时给一条状态：搜索结果关掉之后队列还在后台跑，
          没有这个提示就完全看不见了。 */}
      {active > 0 && (
        <span className="kd-titlebar-status">
          <Download size={12} />
          {active} 个下载中
        </span>
      )}

      <div className="kd-titlebar-spacer" />

      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={isDark ? "切到日间模式" : "切到夜间模式"}
        title={isDark ? "日间模式" : "夜间模式"}
        onClick={() => void saveSettings({ theme: isDark ? "light" : "dark" })}
      >
        {isDark ? <Sun size={13} /> : <Moon size={13} />}
      </Button>

      {!isMac && (
        <div className="kd-row">
          <Button variant="ghost" size="sm" iconOnly aria-label="最小化" onClick={control("minimize")}>
            <Minus size={13} />
          </Button>
          <Button variant="ghost" size="sm" iconOnly aria-label="最大化" onClick={control("maximize")}>
            <Square size={11} />
          </Button>
          <Button variant="ghost" size="sm" iconOnly aria-label="关闭" onClick={control("close")}>
            <X size={13} />
          </Button>
        </div>
      )}
    </header>
  );
}
