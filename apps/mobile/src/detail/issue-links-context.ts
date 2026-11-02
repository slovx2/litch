// React 上下文单独放置：编号改写与解析是纯逻辑，Node 单测不加载界面运行时。
import { createContext } from 'react'
import type { IssueLinks } from './issue-links'

export const IssueLinksContext = createContext<IssueLinks | null>(null)
