import { useState } from "react";
import { AudioLines } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { liveVjChannelLabel, type LiveVjInputDevice } from "../../lib/liveVj";
import { Select } from "../common/Select";

type AudioRoute = "standard" | "master-copy";

// This chooses a capture endpoint, not a new audio transport. VDJ must supply
// its second Master itself; never change its configuration or Windows defaults.
export function useLiveVjAudioRouting(devices: LiveVjInputDevice[], activeInput?: string) {
  const windows = getBridge().platform === "win32";
  const [route, setRoute] = useState<AudioRoute>("standard");
  const [selections, setSelections] = useState<Record<AudioRoute, string>>({standard: "auto", "master-copy": ""});
  const secondary = windows && route === "master-copy";
  const active = secondary ? "master-copy" : "standard";
  const input = activeInput ?? selections[active];
  // Require an explicit endpoint for the extra Master. In particular, do not
  // follow "default playback device", which may be the ASIO controller itself
  // or change while VDJ keeps sending to the previously configured PC output.
  const choices = secondary ? devices.filter(device => device.kind === "output" && device.id.startsWith("loopback:")) : devices;
  return {
    windows, secondary, route: active, setRoute, input, choices,
    selected: choices.find(device => device.id === input),
    setInput: (id: string) => setSelections(previous => ({...previous, [active]: id})),
  };
}
type Routing = ReturnType<typeof useLiveVjAudioRouting>;

export function LiveVjAudioRoute({routing, loading}: {routing: Routing; loading: boolean}) {
  if (!routing.windows) return null;
  return <label><AudioLines size={13}/><span>接入方式</span>
    <Select aria-label="音频接入方式" value={routing.route} disabled={loading}
      onChange={event => { if (event.target.value === "standard" || event.target.value === "master-copy") routing.setRoute(event.target.value); }}>
      <option value="standard">常规采集 · 回环 / 输入</option>
      <option value="master-copy">第二路 Master · 电脑声卡</option>
    </Select>
  </label>;
}

export function LiveVjMasterCopyGuide({routing, channelStart}: {routing: Routing; channelStart: number}) {
  if (!routing.secondary) return null;
  const device = routing.selected;
  const channelsValid = device && !device.error && channelStart % 2 === 0 && channelStart < device.channels;
  return <details className="kd-live-vj-routing-guide">
    <summary>VDJ / Inpulse 500 设置</summary>
    <p>保留 500 的 ASIO 主输出和耳机预听。在 VDJ「设置 → 音频」的 Outputs 区域点 +，新增一行 master，发送到电脑声卡的 WASAPI 共享输出，再点 Apply。</p>
    <table aria-label="VDJ Inpulse 500 输出配置">
      <thead><tr><th>来源</th><th>设备</th><th>声道</th></tr></thead>
      <tbody>
        <tr><td>master</td><td>Inpulse 500 ASIO</td><td>OUT 1 &amp; 2</td></tr>
        <tr><td>headphones</td><td>Inpulse 500 ASIO</td><td>OUT 3 &amp; 4</td></tr>
        <tr><td>master（新增）</td><td>电脑声卡 WASAPI</td><td>与 KDJ 所选声道一致</td></tr>
      </tbody>
    </table>
    {device && <p>当前接收设备：<strong>{device.label}</strong>{channelsValid && <> · {liveVjChannelLabel(device, channelStart)}</>}</p>}
    <p>KDJ 的「播放设备」必须与新增 master 行指向同一设备。不要替换原来的 master，不要把 headphones 送到电脑声卡；此处不会自动修改 VDJ，也不安装虚拟声卡。</p>
    <p>先确认 Master 播放时 KDJ 有电平，再将播放通道推子拉到底，只开 Cue：耳机应有声，KDJ 应静音。观察运行中的实时电平，不看停止后的残留读数。</p>
    <p>电脑声卡可能实际发声，也可能混入通知或浏览器声音。不要依赖 Windows 静音来保证仍能采集；额外输出延迟和主输出／预听隔离需按当前设备验证。</p>
  </details>;
}
