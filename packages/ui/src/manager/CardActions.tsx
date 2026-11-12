import { createContext, type ReactNode, useContext, useState } from 'react'
import { createPortal } from 'react-dom'

const Actions = createContext<{ target: HTMLElement | null } | null>(null)

/** 每张卡只有一个操作栏；内嵌的旧式帖子沿用外层卡片的边界。 */
export function CardActionScope({
  children,
  active = true,
}: {
  children(footer: ReactNode): ReactNode
  active?: boolean
}) {
  const parent = useContext(Actions)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  if (parent) return children(null)
  return (
    <Actions.Provider value={active ? { target } : null}>
      {children(active ? <footer className="mg-card-actions" ref={setTarget} /> : null)}
    </Actions.Provider>
  )
}

/** 将分散的按钮汇入卡尾；表单、正文仍保留在原来的阅读顺序里。 */
export function CardActions({ children }: { children: ReactNode }) {
  const scope = useContext(Actions)
  if (!scope) return children
  return scope.target ? createPortal(children, scope.target) : null
}
