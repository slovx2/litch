// 系统卡片里的正文（子会话的回报、派出卡上的回报、经理事件、别的会话发来的话）：
// 和助手回答同一套 Markdown 渲染，文件链接点开同样进文件查看器；字号行距跟卡片走，排得更紧（tree.css 的 .card-md）。
// 不给滚动定位的标记：卡片自己带着，里面的块再带就套住了
import { Markdown } from './Markdown.tsx'

export function CardMarkdown({ text }: { text: string }) {
  return (
    <div className="card-md">
      <Markdown text={text} streaming={false} />
    </div>
  )
}
