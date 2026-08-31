const DRAG_PREVIEW_SIZE = 128;

function canvasPngBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

/** 没有封面时仍给系统一个中性的黑胶预览，不把 KDJ 应用图标当成歌曲。 */
export function vinylDragPreview(): string {
  const canvas = document.createElement("canvas");
  canvas.width = DRAG_PREVIEW_SIZE;
  canvas.height = DRAG_PREVIEW_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const center = DRAG_PREVIEW_SIZE / 2;
  context.clearRect(0, 0, DRAG_PREVIEW_SIZE, DRAG_PREVIEW_SIZE);
  context.fillStyle = "#202124";
  context.beginPath();
  context.arc(center, center, center - 4, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, 0.16)";
  context.lineWidth = 1;
  for (const radius of [24, 34, 44, 54]) {
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.stroke();
  }
  context.fillStyle = "#d8d8d8";
  context.beginPath();
  context.arc(center, center, 17, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#202124";
  context.beginPath();
  context.arc(center, center, 4, 0, Math.PI * 2);
  context.fill();
  return canvasPngBase64(canvas);
}

/** 把任意比例的歌曲封面居中裁成原生拖放适用的 128×128 PNG。 */
export async function dragPreviewFromBlob(blob: Blob): Promise<string> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("封面无法解码"));
      image.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = DRAG_PREVIEW_SIZE;
    canvas.height = DRAG_PREVIEW_SIZE;
    const context = canvas.getContext("2d");
    if (!context || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return vinylDragPreview();
    }
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      DRAG_PREVIEW_SIZE,
      DRAG_PREVIEW_SIZE,
    );
    return canvasPngBase64(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** HTML5 外拖同步使用已经渲染好的封面节点，避免整行 KDJ 界面成为拖拽影像。 */
export function setCoverDragImage(dataTransfer: DataTransfer, source: Element | null): void {
  if (!source) return;
  const cover = source?.closest("tr")?.querySelector<HTMLElement>(".kd-thumb img, .kd-thumb")
    ?? source?.querySelector<HTMLElement>(".kd-thumb img, .kd-thumb")
    ?? (source.matches(".kd-thumb img, .kd-thumb") ? source as HTMLElement : null);
  if (!cover) return;
  const rect = cover.getBoundingClientRect();
  dataTransfer.setDragImage(cover, Math.max(1, rect.width / 2), Math.max(1, rect.height / 2));
}
