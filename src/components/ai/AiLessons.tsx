/**
 * 使用提示 → AI (docs/ai-dock.md): how to get the AI corner going, as steps — pi, a key (DeepSeek
 * for the example), then one sentence. An example line opens the corner with it written in.
 */
import { useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { openAiSettings } from "../../lib/aiSettings";
import { getBridge } from "../../lib/bridge";
import { copyText } from "../../lib/copyText";
import { useAiStore } from "../../stores/aiStore";
import "./AiLessons.css";

const PI_SITE = "https://pi.dev";
const DEEPSEEK_KEYS = "https://platform.deepseek.com/api_keys";
const INSTALL = "npm install -g @earendil-works/pi-coding-agent";
const EXAMPLES = [
  "帮我下载最近新番 FX 战士里的歌",
  "下载 YOASOBI 最新的单曲，要无损",
  "下载 FX 战士 OP 的 B 站 MV，放进「MV」文件夹",
];

function Link({ href, children }: { href: string; children: ReactNode }) {
  return <a className="kd-ai-link" href={href} target="_blank" rel="noreferrer" onClick={event => {
    const openExternal = getBridge().openExternal;
    if (!openExternal) return;
    event.preventDefault();
    void openExternal(href);
  }}>{children}</a>;
}

export function AiLessons() {
  const [copied, setCopied] = useState(false);
  const suggest = useAiStore(state => state.suggest);
  return <ol className="kd-tips-lessons kd-ai-lessons">
    <li>
      <p>下载 <Link href={PI_SITE}>pi</Link>：一个开源的 AI 助手，装好后 KDJ 直接调用它。</p>
      <div className="kd-ai-lesson-command">
        <code>{INSTALL}</code>
        <button type="button" className="kd-ai-key" aria-label="复制命令" title={copied ? "已复制" : "复制命令"}
          onClick={() => void copyText(INSTALL).then(() => setCopied(true), () => setCopied(false))}>
          <Copy size={13} aria-hidden="true" />
        </button>
      </div>
    </li>
    <li>
      <p>以 DeepSeek 为例：在 <Link href={DEEPSEEK_KEYS}>DeepSeek 开放平台</Link> 创建一个 API Key，
        然后在 <button type="button" className="kd-ai-link" onClick={openAiSettings}>设置 → 系统 → AI</button> 里选 DeepSeek，粘贴 Key 添加；全局 pi 里已有的 Key 可以直接导入。
        网页搜索默认用 pi-web-access，在同一处点「安装」。</p>
    </li>
    <li>
      <p>点聚合搜索框右边的 ✨ 键切到 Agent Mode，搜索框就变成交给 AI 的输入。一句话说你要什么：找歌、下载、播放、查曲库、给视频截帧和对齐都行，下到哪个文件夹也直接说。</p>
      <p>AI 不说话，直接动手：搜的歌出现在搜索页，下载进下载栏，每一步在顶部提示；需要你决定时，右下角会弹出选项。工作时你随时可以自己操作，它会接着你的改动做。</p>
      <div className="kd-ai-examples">
        {EXAMPLES.map(example => <button key={example} type="button" className="kd-ai-example" onClick={() => suggest(example)}>
          {example}
        </button>)}
      </div>
    </li>
    <li>
      <p>名字记不清也没关系：它会先上网查到准确的歌名，再去各平台搜；几种写法会一起搜，结果交错排在搜索页里。</p>
    </li>
  </ol>;
}
