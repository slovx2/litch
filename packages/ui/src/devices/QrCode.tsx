// 二维码：用 uqr 算出每一格，自己画成一张 SVG（一条路径），不往页面里塞 HTML。
// 纠错等级 M：配对文本两三百字节，屏幕上扫足够；四周留 4 格空白，扫码器要它。
import { useMemo } from 'react'
import { encode } from 'uqr'

const QUIET = 4

/** 文本算成格子，画成一条路径：每个黑格一个 1×1 的方块 */
function pathOf(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { ecc: 'M', border: 0 })
  const parts: string[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (data[row]?.[col]) parts.push(`M${col + QUIET} ${row + QUIET}h1v1h-1z`)
    }
  }
  return { size: size + QUIET * 2, d: parts.join('') }
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => pathOf(text), [text])
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      data-qr-size={size}
    >
      <rect width={size} height={size} className="qr-paper" />
      <path d={d} className="qr-ink" />
    </svg>
  )
}
