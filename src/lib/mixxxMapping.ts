/**
 * Mixxx 控制器映射的只读兼容层。
 *
 * KDJ 不执行下载映射里的任意 JavaScript。XML 里的设备身份和直接 control 绑定可以
 * 安全索引；脚本映射只登记依赖，等受限兼容运行时接入后再启用。
 */

export type ControllerProtocol = "midi" | "hid";

export interface ControllerDeviceIdentity {
  protocol: ControllerProtocol;
  vendorId: number | null;
  productId: number | null;
  usagePage: number | null;
  usage: number | null;
  interfaceNumber: number | null;
}

export interface MixxxControlBinding {
  group: string;
  key: string;
  status: number | null;
  midino: number | null;
  options: string[];
}

export interface MixxxMappingManifest {
  name: string;
  author: string;
  description: string;
  devices: ControllerDeviceIdentity[];
  scripts: string[];
  controls: MixxxControlBinding[];
}

export type KdjControllerTarget =
  | { kind: "deck-play" | "deck-cue" | "deck-sync"; deck: 0 | 1 }
  | { kind: "deck-hot-cue"; deck: 0 | 1; slot: number }
  | { kind: "deck-volume" | "deck-gain" | "deck-high" | "deck-mid" | "deck-low" | "deck-filter" | "deck-fx"; deck: 0 | 1 }
  | { kind: "crossfader" | "crossfader-enable" | "head-mix" | "head-gain" | "master-gain" };

type DeckContinuousTarget =
  | "deck-volume"
  | "deck-gain"
  | "deck-high"
  | "deck-mid"
  | "deck-low"
  | "deck-filter"
  | "deck-fx";

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function textTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : "";
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    result[match[1].toLowerCase()] = decodeXml(match[3]);
  }
  return result;
}

function integer(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, value.toLowerCase().startsWith("0x") ? 16 : 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMixxxMapping(xml: string): MixxxMappingManifest {
  const info = xml.match(/<info(?:\s[^>]*)?>([\s\S]*?)<\/info>/i)?.[1] ?? xml;
  const devices: ControllerDeviceIdentity[] = [];
  for (const match of info.matchAll(/<product\b([^>]*)\/?\s*>/gi)) {
    const attrs = attributes(match[1]);
    const protocol = attrs.protocol?.toLowerCase();
    if (protocol !== "midi" && protocol !== "hid") continue;
    devices.push({
      protocol,
      vendorId: integer(attrs.vendor_id),
      productId: integer(attrs.product_id),
      usagePage: integer(attrs.usage_page),
      usage: integer(attrs.usage),
      interfaceNumber: integer(attrs.interface_number),
    });
  }

  const scripts = Array.from(xml.matchAll(/<file(?:\s[^>]*)?>([\s\S]*?)<\/file>/gi))
    .map((match) => decodeXml(match[1].trim()))
    .filter(Boolean);
  const controls: MixxxControlBinding[] = [];
  for (const match of xml.matchAll(/<control(?:\s[^>]*)?>([\s\S]*?)<\/control>/gi)) {
    const body = match[1];
    const group = textTag(body, "group");
    const key = textTag(body, "key");
    if (!group || !key) continue;
    controls.push({
      group,
      key,
      status: integer(textTag(body, "status")),
      midino: integer(textTag(body, "midino")),
      options: textTag(body, "options").split(/\s*,\s*/).filter(Boolean),
    });
  }

  return {
    name: textTag(info, "name"),
    author: textTag(info, "author"),
    description: textTag(info, "description"),
    devices,
    scripts,
    controls,
  };
}

export function mappingMatchesDevice(
  mapping: MixxxMappingManifest,
  device: ControllerDeviceIdentity,
): boolean {
  return mapping.devices.some((candidate) =>
    candidate.protocol === device.protocol &&
    candidate.vendorId !== null &&
    candidate.productId !== null &&
    candidate.vendorId === device.vendorId &&
    candidate.productId === device.productId &&
    (candidate.interfaceNumber === null || device.interfaceNumber === null || candidate.interfaceNumber === device.interfaceNumber),
  );
}

export function mixxxControlTarget(group: string, key: string): KdjControllerTarget | null {
  const channel = group.match(/^\[Channel([12])\]$/i);
  if (channel) {
    const deck = (Number(channel[1]) - 1) as 0 | 1;
    if (/^(play|play_indicator)$/i.test(key)) return { kind: "deck-play", deck };
    if (/^cue_default$/i.test(key)) return { kind: "deck-cue", deck };
    if (/^sync_enabled$/i.test(key)) return { kind: "deck-sync", deck };
    const hotCue = key.match(/^hotcue_([1-8])_activate$/i);
    if (hotCue) return { kind: "deck-hot-cue", deck, slot: Number(hotCue[1]) };
    const controls: Record<string, DeckContinuousTarget> = {
      volume: "deck-volume",
      pregain: "deck-gain",
      filterhigh: "deck-high",
      filtermid: "deck-mid",
      filterlow: "deck-low",
      filterquickeffect: "deck-filter",
      super1: "deck-fx",
    };
    const kind = controls[key.toLowerCase()];
    return kind ? { kind, deck } : null;
  }
  if (/^\[Master\]$/i.test(group)) {
    const controls: Record<string, KdjControllerTarget["kind"]> = {
      crossfader: "crossfader",
      crossfader_enable: "crossfader-enable",
      headmix: "head-mix",
      headgain: "head-gain",
      gain: "master-gain",
    };
    const kind = controls[key.toLowerCase()];
    return kind ? { kind: kind as "crossfader" | "crossfader-enable" | "head-mix" | "head-gain" | "master-gain" } : null;
  }
  return null;
}
