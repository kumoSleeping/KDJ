import { addPluginListener, invoke } from '@tauri-apps/api/core';

const PLUGIN_NAME = 'native-audio';
const STATE_EVENT = 'native_audio_state';
const OVERLAY_MOVED_EVENT = 'native_lyrics_overlay_moved';

const call = async (command, payload) => {
  return await invoke(`plugin:${PLUGIN_NAME}|${command}`, payload);
};

export const initialize = async () => await call('initialize');
export const setSource = async (payload) => await call('set_source', payload);
export const setQueue = async (items) => await call('set_queue', { items });
export const play = async () => await call('play');
export const pause = async () => await call('pause');
export const seekTo = async (position) => await call('seek_to', { position });
export const setRate = async (rate) => await call('set_rate', { rate });
export const setVolume = async (volume) => await call('set_volume', { volume });
export const getState = async () => await call('get_state');
export const getProgressCheckpoint = async () => await call('get_progress_checkpoint');
export const clearProgressCheckpoint = async () => await call('clear_progress_checkpoint');
export const dispose = async () => await call('dispose');
export const addStateListener = async (handler) => await addPluginListener(PLUGIN_NAME, STATE_EVENT, handler);

// 歌词悬浮窗：时间轴只在换歌或切附加层时推一次，之后由原生侧读 ExoPlayer 位置自己滚。
export const setLyricsTimeline = async (payload) => await call('set_lyrics_timeline', payload);
export const setLyricsOverlay = async (payload) => await call('set_lyrics_overlay', payload);
export const checkOverlayPermission = async () => await call('check_overlay_permission');
export const requestOverlayPermission = async () => await call('request_overlay_permission');
export const addOverlayMovedListener = async (handler) =>
  await addPluginListener(PLUGIN_NAME, OVERLAY_MOVED_EVENT, handler);

/** 安卓：PNG data URL → MediaStore 相册（Pictures/KDJ）。 */
export const savePngToGallery = async (payload) => await call('save_png_to_gallery', payload);
/** 安卓：用系统查看器打开本地路径或 content URI。 */
export const openLocalPath = async (path) => await call('open_local_path', { path });
/** 安卓：系统文件夹选择器，返回可扫描的真实路径；取消为 null。 */
export const pickLibraryFolder = async () => {
  const result = await call('pick_library_folder');
  const path = result?.path;
  return typeof path === 'string' && path ? path : null;
};
