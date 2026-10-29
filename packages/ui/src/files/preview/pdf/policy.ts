/** PDF 的尺寸上限独立于文件字节数；扫描件可能以很小的文件解出巨大位图。 */
export const PDF_BYTES = 20 * 1024 * 1024
export const PDF_PAGES = 200
export const PDF_PIXELS = 16_000_000
export const PDF_PAGE_PIXELS = 4_000_000
export const PDF_TIMEOUT = 20_000
export const PDF_TEXT_ITEMS = 10_000
export const PDF_TEXT_CHARS = 100_000
export const GAP = 16
export interface PageSize {
  width: number
  height: number
}
export interface PageBox extends PageSize {
  top: number
  scale: number
}

export function pageLayout(sizes: PageSize[], width: number, zoom: number): PageBox[] {
  let top = GAP
  return sizes.map((size) => {
    const scale = Math.min(Math.max(1, width - GAP * 2) / size.width, 20_000 / size.height) * zoom
    const box = { width: size.width * scale, height: size.height * scale, top, scale }
    top += Math.max(128, box.height) + GAP
    return box
  })
}
/** 仅保留可见页与前后各一页。页面最小占位高避免小纸张一次挂载几百张画布。 */
export function visiblePages(boxes: PageBox[], top: number, height: number): number[] {
  const first = Math.max(
    0,
    boxes.findIndex((box) => box.top + Math.max(128, box.height) > top),
  )
  let last = first
  while (last + 1 < boxes.length && (boxes[last + 1]?.top ?? Infinity) < top + height) last++
  return Array.from(
    { length: Math.min(boxes.length - 1, last + 1) - Math.max(0, first - 1) + 1 },
    (_, index) => Math.max(0, first - 1) + index,
  )
}
export function rasterScale(box: PageSize, count: number, dpr: number): number {
  return Math.min(
    dpr,
    2,
    Math.sqrt(Math.min(PDF_PAGE_PIXELS, PDF_PIXELS / count) / (box.width * box.height)),
  )
}
export function validSize(size: PageSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= 20_000 &&
    size.height <= 20_000
  )
}
