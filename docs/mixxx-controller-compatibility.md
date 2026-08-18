# Mixxx 控制器映射兼容方案

## 目标与边界

KDJ 复用 Mixxx 的**设备识别和控制语义**，不直接嵌入 Mixxx，也不把下载到的 JavaScript
当可信代码执行。映射分三层接入：

1. XML `<devices>`：用于 USB MIDI/HID 自动识别；
2. XML `<controls>`：无脚本的 MIDI 控件可直接翻译；
3. JavaScript：只登记依赖。后续要么实现受限兼容 API，要么为该设备提供 KDJ 原生适配器。

当前解析边界在 `src/lib/mixxxMapping.ts`。它已经能读取产品 ID、脚本文件和直接 control，
并把 KDJ 已有的双 Deck 控件翻译成稳定目标。它不会执行脚本。

## 官方格式依据

- Mixxx 官方映射目录：<https://github.com/mixxxdj/mixxx/tree/main/res/controllers>
- MIDI mapping 文件格式：<https://github.com/mixxxdj/mixxx/wiki/MIDI-controller-mapping-file-format>
- MIDI JavaScript mapping：<https://github.com/mixxxdj/mixxx/wiki/midi-scripting>
- HID mapping：<https://github.com/mixxxdj/mixxx/wiki/Hid-Mapping>
- 设备 ID 实例（Traktor Kontrol S4 MK2）：
  <https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Traktor%20Kontrol%20S4%20MK2.hid.xml>

实现研究固定参考了本机 Mixxx checkout `9e670c1120cc82304c4d5dcaa11a36367c5d50c3`
下的 `res/controllers`。上线的目录索引仍应记录来源 commit，不能悄悄随 `main` 漂移。

新版映射可在 `<devices>` 里明确写：

```xml
<product protocol="hid"
         vendor_id="0x17cc"
         product_id="0x1310"
         usage_page="0xff01"
         usage="0x1"
         interface_number="0x4" />
```

这比按设备显示名猜型号可靠。MIDI 设备若没有 VID/PID，则退回 CoreMIDI/WinMM/ALSA
端口名和映射 `name` 的规范化匹配，但只能给“候选”，不能静默自动启用。

## KDJ 控制目标

首批直接支持以下 Mixxx control：

| Mixxx group/key | KDJ |
| --- | --- |
| `[Channel1/2] play` | Deck A/B 播放或暂停 |
| `[Channel1/2] cue_default` | 主 CUE |
| `[Channel1/2] sync_enabled` | SYNC，默认目标 128 BPM |
| `hotcue_1_activate` … `hotcue_8_activate` | 8 个 Hot Cue |
| `volume` / `pregain` | 通道推子 / Gain |
| `filterHigh` / `filterMid` / `filterLow` | 三段 EQ |
| `filterQuickEffect` | 双极 Filter |
| `super1` | 当前效果器总参数 |
| `[Master] crossfader` | 横向 crossfader |
| `[Master] headMix` / `headGain` | Cue/Master Mix / 耳机音量 |
| `[Master] gain` | Master |

解析器遇到未知 group/key 应忽略并列入诊断，不得误绑到“最像”的控制。

## 自动发现、搜索和下载

桌面端后续接入顺序：

1. Rust 枚举 MIDI 输入端口和 HID 设备，输出协议、VID/PID、usage/interface、显示名；
2. 用本地映射索引精确匹配 `<devices>`；
3. 只有一个精确匹配时弹出非阻塞提示，展示型号、来源和将启用的控制数；
4. 没有精确匹配时允许按名称搜索官方目录与 Mixxx Controller Mapping 论坛；
5. 下载 XML 和相邻 JS 到 KDJ 数据目录的 `controllers/`，保存 SHA-256、来源 URL、来源
   commit 和下载时间；更新映射必须再次确认；
6. XML 直接映射可启用。含 JS 的映射在没有对应兼容适配器时显示“已下载，脚本尚不兼容”，
   绝不退回 `eval`。

搜索结果优先级：设备 ID 精确匹配 > 官方同型号名称 > 用户本地映射 > 社区名称候选。
自动弹窗要对同一个设备/映射版本去重；插拔不能反复打断演出界面。

## 音频输出与监听

控制器输入和声卡输出是两件事。映射匹配成功不代表控制器的多通道声卡已经成为 KDJ 输出。
真正的耳机 PFL 需要在 CPAL 层选择至少四通道输出，或选择独立 Master/Cue 两个设备：

- Master bus → 主输出 1/2；
- Cue bus → 耳机输出 3/4；
- 每 Deck 的 headphone CUE 只进入 Cue bus；
- Cue/Master Mix 在 Cue bus 内混合，不改变 Master bus。

当前 Performance UI 已实现默认监听另一侧 Deck 的策略和控制状态，但现有 CPAL renderer 仍是
单立体声 Master 输出；不能把同一对声道上的“静音预听”冒充真实耳机监听。多输出路由完成前，
界面要把输出能力作为设备状态展示，而不是声称 PFL 已经发往耳机。

