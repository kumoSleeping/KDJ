import { useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { Button, InlineNotice } from "../common";
import { AccountRow } from "./AccountRow";
import { UpdateRow } from "./UpdateRow";

/**
 * 「账号管理」住在右侧详情栏里，由列表标签行最右侧的按钮呼出。
 *
 * 整页设置和弹窗都试过、都被否了：除登录外每个设置都有就地入口
 * （保存目录在下载队列、音质在搜索条、主题在播放器左侧、画质在视频面板、
 * 优先级靠拖动按钮），而详情栏本来就是"当前关注的东西"待的位置。
 * 文件名模板/并发数这类专家参数留在 settings.json 手改。
 */
export function AccountsPanel() {
  const accounts = useAppStore((state) => state.accounts);
  const accountsError = useAppStore((state) => state.accountsError);
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
        <strong>账号管理</strong>
        <span className="kd-toolbar-gap" />
        <Button variant="ghost" size="sm" iconOnly aria-label="关闭" onClick={toggleAccounts}>
          <X size={13} />
        </Button>
      </div>

      {/* 拉不到账号状态时，下面那句"稍等一下"会一直挂着；
          把真正的原因摆在同一块地方，才不至于让人一直等 */}
      <InlineNotice text={accountsError} block />

      <div className="kd-scroll kd-grow" style={{ minHeight: 0, padding: "0 0.85rem 1rem" }}>
        {rows.length === 0 ? (
          <p className="kd-muted">账号状态还没拉到，稍等一下。</p>
        ) : (
          rows.map((account) => <AccountRow key={account.platform} account={account} />)
        )}
        {/* 更新和账号是同一类事（都是"这台机器上的软件本身"），排在账号后面
            同一套行样式，不另开一个设置页 */}
        <UpdateRow />
        {/* 上面每行自带一条下边框，紧贴着的话这段说明会像是"更新行的一部分" */}
        <p
          className="kd-faint"
          style={{ fontSize: "var(--kd-size-xs)", lineHeight: 1.6, marginTop: "0.85rem" }}
        >
          SoundCloud 不需要登录。其它设置都在用的地方直接改：保存目录在下载队列、
          音质在搜索条、主题在播放器左侧、平台优先级拖动按钮排序。
        </p>
      </div>
    </div>
  );
}
