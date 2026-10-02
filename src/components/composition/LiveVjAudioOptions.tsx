import type { LiveVjInputDevice } from "../../lib/liveVj";

// Shared by local VJ and the Bluetooth sender on both desktop platforms.
export function LiveVjAudioOptions({devices}: {devices: LiveVjInputDevice[]}) {
  const option = (device: LiveVjInputDevice) => <option key={device.id} value={device.id}>{device.label}</option>;
  return <>
    {devices.filter(device => device.id === "auto").map(option)}
    {([ ["output", "输出设备捕获"], ["system", "系统混音"], ["input", "录音输入"] ] as const).map(([kind, label]) => {
      const group = devices.filter(device => device.id !== "auto" && device.kind === kind);
      return group.length > 0 ? <optgroup key={kind} label={label}>{group.map(option)}</optgroup> : null;
    })}
  </>;
}
