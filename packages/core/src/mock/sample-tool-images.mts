import type { ToolImage } from '../../../protocol/src/tool-images.mjs'
import type { FilePreview } from '../model-preview.mjs'

// 隔离验收用的合成像素，不读取宿主截图或个人会话。
const DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAYAAADSm7GJAAABYUlEQVR4Ae3BgQ2AAAgDsDo42u/1j4X24f2CIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIFjjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFFvjFPsBquIEkE5ks9gAAAAASUVORK5CYII='
export const SAMPLE_TOOL_IMAGES: ToolImage[] = [0, 1, 2, 3].map((n) => ({
  id: 'a'.repeat(63) + n,
  tool: 'Read screenshot ' + (n + 1),
  mime: 'image/png',
  bytes: 410,
  width: 120,
  height: 80,
  thumbnail: { mime: 'image/png', dataBase64: DATA, width: 120, height: 80 },
}))
export function sampleToolImage(source: string): FilePreview | null {
  return SAMPLE_TOOL_IMAGES.some((image) => source === 'litch-tool-image:' + image.id)
    ? { kind: 'ready', path: source, format: 'image', dataBase64: DATA, bytes: 410 }
    : null
}
