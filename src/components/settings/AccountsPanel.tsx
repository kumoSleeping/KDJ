import { useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { Button } from "../common";
import { AccountRow } from "./AccountRow";

/**
 * 「平台登录」住在右侧详情栏里，由左下角齿轮呼出。
 *
 * 整页设置和弹窗都试过、都被否了：除登录外每个设置都有就地入口
 * （保存目录在下载队列、音质在搜索条、主题在标题栏、画质在视频面板、
 * 优先级靠拖动按钮），而详情栏本来就是"当前关注的东西"待的位置。
 * 文件名模板/并发数这类专家参数留在 settings.json 手改。
 */
export function AccountsPanel() {
  const accounts = useAppStore((state) => state.accounts);
  const refreshAccounts = useAppStore((state) => state.refreshAccounts);
  const toggleAccounts = useAppStore((state) => state.toggleAccounts);

  // 打开时刷一次状态：登录是否过期只有后端知道，别拿启动时的旧缓存糊弄人
  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  // SoundCloud 没有账号体系（supports_login=false），不占一行
  const rows = accounts.filter((account) => account.supports_login);

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-toolbar">
        <strong>平台登录</strong>
        <span className="kd-toolbar-gap" />
        <Button variant="ghost" size="sm" iconOnly aria-label="关闭" onClick={toggleAccounts}>
          <X size={13} />
        </Button>
      </div>

      <div className="kd-scroll kd-grow" style={{ minHeight: 0, padding: "0 0.85rem 1rem" }}>
        {rows.length === 0 ? (
          <p className="kd-muted">账号状态还没拉到，稍等一下。</p>
        ) : (
          rows.map((account) => <AccountRow key={account.platform} account={account} />)
        )}
        <p className="kd-faint" style={{ fontSize: "var(--kd-size-xs)", lineHeight: 1.6 }}>
          SoundCloud 不需要登录。其它设置都在用的地方直接改：保存目录在下载队列、
          音质在搜索条、主题在右上角、平台优先级拖动按钮排序。
        </p>
      </div>
    </div>
  );
}
