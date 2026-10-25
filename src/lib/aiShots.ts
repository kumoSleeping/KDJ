/**
 * The frames a `kdj_peek` call cut, as pictures the window can show (docs/ai-dock.md): the
 * pictures the model was handed with the result (kdj-tools.ts: the contact sheet when there is
 * one, else the first frames), each with the moment it shows. A model that sees no pictures is
 * handed none, and then there is nothing to show either.
 */
import { formatDuration } from "./format";

export interface AiShot {
  /** A `data:` address. */
  src: string;
  /** The moment it shows, or how many frames a contact sheet holds. */
  label: string;
}

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => (value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {});

/** Read once per result: the record redraws with every word the AI streams. */
const read = new WeakMap<object, AiShot[]>();

/** The shots in a tool result (`{ content: [{ type: "image", data, mimeType }], details }`). */
export function peekShots(result: unknown): AiShot[] {
  if (!result || typeof result !== "object") return [];
  const known = read.get(result);
  if (known) return known;
  const shots = readShots(fields(result));
  read.set(result, shots);
  return shots;
}

function readShots(data: Fields): AiShot[] {
  const content = Array.isArray(data.content) ? data.content.map(fields) : [];
  const images = content
    .filter(block => block.type === "image" && typeof block.data === "string" && block.data)
    .map(block => `data:${typeof block.mimeType === "string" ? block.mimeType : "image/jpeg"};base64,${block.data as string}`);
  if (images.length === 0) return [];
  const details = fields(data.details);
  const frames = Array.isArray(details.frames) ? details.frames.map(fields) : [];
  if (details.sheet && images.length === 1) return [{ src: images[0], label: `${frames.length} 帧` }];
  return images.map((src, index) => {
    const at = frames[index]?.at;
    return { src, label: typeof at === "number" ? formatDuration(at) : "" };
  });
}

/** How many frames the call cut that are not among its shots. */
export function peekUnshown(result: unknown): number {
  const data = fields(result);
  const details = fields(data.details);
  if (details.sheet) return 0;
  const frames = Array.isArray(details.frames) ? details.frames.length : 0;
  return Math.max(0, frames - peekShots(result).length);
}
