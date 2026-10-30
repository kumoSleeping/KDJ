// `kdj peek` (crates/kdj-server/src/cli_media.rs): the server asks the open windows for a
// video's frames, and the first one to claim the request decodes them with the system decoder
// (codecFrames.ts) and sends each back as a JPEG, then a contact sheet of them all.
import { api, framesApi } from "./api";
import { openVideoFrames, toJpeg } from "./codecFrames";

export interface CliPeek {
  id: string;
  from: { track_id: number } | { path: string } | { bilibili: { bvid: string; page: number } };
  at: number[];
  every?: number | null;
  width: number;
  max_frames: number;
  sheet_columns: number;
  duration?: number | null;
}

/** A sheet's tile is at most this wide, so 48 frames stay one picture of reasonable size. */
const SHEET_TILE = 320;
const SHEET_GAP = 4;

function sourceUrl(from: CliPeek["from"]): string {
  if ("track_id" in from) return api.videoUrl(from.track_id);
  if ("path" in from) return framesApi.peekSourceUrl(from.path);
  return api.videoPreviewUrl("bilibili", from.bilibili.bvid, from.bilibili.page, "video");
}

function times(request: CliPeek, duration: number): number[] {
  const out = [...request.at];
  if (request.every && request.every > 0) {
    for (let t = 0; t < duration && out.length < request.max_frames; t += request.every) out.push(t);
  }
  // The last frame a little before the end, where a seek still finds a picture.
  return out.slice(0, request.max_frames).map(t => Math.max(0, Math.min(t, duration - 0.1)));
}

export async function peekForCli(request: CliPeek): Promise<void> {
  if (!(await framesApi.claimPeek(request.id).catch(() => ({ claimed: false }))).claimed) return;
  try {
    const frames = await openVideoFrames(sourceUrl(request.from), request.width);
    try {
      const wanted = times(request, frames.duration);
      const done: Array<{ n: number; at: number }> = [];
      const failed: Array<{ at: number; error: string }> = [];
      const tiles: Array<HTMLCanvasElement | OffscreenCanvas> = [];
      for (const [index, at] of wanted.entries()) {
        try {
          const canvas = await frames.canvas(at);
          if (!canvas) { failed.push({ at, error: "这个时间点没有画面" }); continue; }
          await framesApi.peekPicture(request.id, await toJpeg(canvas), index + 1);
          done.push({ n: index + 1, at });
          tiles.push(canvas);
        } catch (error) {
          failed.push({ at, error: error instanceof Error ? error.message : String(error) });
        }
      }
      let sheet: { columns: number; rows: number } | undefined;
      if (tiles.length > 1) {
        const columns = Math.min(request.sheet_columns, tiles.length);
        const rows = Math.ceil(tiles.length / columns);
        const width = Math.min(SHEET_TILE, tiles[0].width);
        const height = Math.round(width * tiles[0].height / tiles[0].width);
        const canvas = document.createElement("canvas");
        canvas.width = columns * width + (columns + 1) * SHEET_GAP;
        canvas.height = rows * height + (rows + 1) * SHEET_GAP;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          tiles.forEach((tile, n) => {
            const x = SHEET_GAP + (n % columns) * (width + SHEET_GAP);
            const y = SHEET_GAP + Math.floor(n / columns) * (height + SHEET_GAP);
            ctx.drawImage(tile as CanvasImageSource, x, y, width, height);
          });
          await framesApi.peekPicture(request.id, await toJpeg(canvas));
          sheet = { columns, rows };
        }
      }
      await framesApi.finishPeek(request.id, { report: { frames: done, failed, sheet } });
    } finally {
      frames.dispose();
    }
  } catch (error) {
    await framesApi.finishPeek(request.id, { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  }
}
