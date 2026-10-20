// 自己画的占位图标，16 像素网格、描边风格。正式图标在界面定稿后统一换。
const PATHS = {
  term: <path d="M3.5 5l3 3-3 3M8.5 11.5h4" />,
  edit: <path d="M3 13l.6-2.8L10.8 3 13 5.2 5.8 12.4z" />,
  think: (
    <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.5 4.5L6 6M10 10l1.5 1.5M11.5 4.5L10 6M6 10l-1.5 1.5" />
  ),
  tool: <path d="M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10 6.5v3M5 10v3" />,
  search: <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3L13.5 13.5" />,
  info: <path d="M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3.5M8 5v.5" />,
  /** 侧面板：一个窗口，右边隔出一栏 */
  side: <path d="M2.5 3.5h11v9h-11zM9.5 3.5v9" />,
  /** 侧栏：一个窗口，左边隔出一栏 */
  sidebar: <path d="M2.5 3.5h11v9h-11zM6.5 3.5v9" />,
  /** 筛选：一个漏斗 */
  filter: <path d="M2.5 3.5h11L9.5 8.5v4.5l-3-1.5v-3z" />,
  /** 文件树：一根主干，岔出两支 */
  tree: <path d="M4 3.5h6M4 3.5V12h3M4 7.5h3M9.5 7.5h3.5M9.5 12h3.5" />,
  /** 子会话、子代理：上面一个方块，往下岔出两个小方块 */
  agents: <path d="M6 2.5h4v3H6zM8 5.5v2.5M4 8h8M4 8v2M12 8v2M2.5 10h3v3h-3zM10.5 10h3v3h-3z" />,
  folder: <path d="M2.5 4.5h4L8 6h5.5v6.5h-11z" />,
  /** 展开着的目录：盖子掀开了 */
  folderOpen: <path d="M2.5 12.5v-8h4L8 6h4.5v2M2.5 12.5l1.8-4.5h9.7l-1.8 4.5z" />,
  /** 文件：一张折了角的纸 */
  file: <path d="M4.5 2.5H9l3 3v8H4.5zM9 2.5v3h3" />,
  /** 复制：两张叠着的纸 */
  copy: <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
  /** 重新取：一个没合上的圈，带一个回头的箭头 */
  reload: <path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.2M12.5 3v2.5H10" />,
  /** 差异：上面一个加号，下面一个减号 */
  diff: <path d="M8 2.5v5M5.5 5h5M5.5 12h5" />,
  /** 并排：一个框从中间竖着分开 */
  split: <path d="M2.5 3.5h11v9h-11zM8 3.5v9" />,
  /** 合并：一个框里上下两栏 */
  unified: <path d="M2.5 3.5h11v9h-11zM2.5 8h11" />,
  /** 折行：一行字折回来接着写 */
  wrap: (
    <path d="M2.5 4.5h11M2.5 8.5h8.2a1.9 1.9 0 0 1 0 3.8H8.5M10 10.8l-1.5 1.5 1.5 1.5M2.5 12.3h3" />
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  /** 还原：往回拐的箭头 */
  undo: <path d="M5.5 6.5h4.7a2.8 2.8 0 0 1 0 5.6H6.5M7.5 4.5l-2 2 2 2" />,
  up: <path d="M4 10l4-4 4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  /** 网页：一个地球，一圈经线一道纬线 */
  globe: (
    <path d="M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM2.5 8h11M8 2.5c-2 2.8-2 8.2 0 11M8 2.5c2 2.8 2 8.2 0 11" />
  ),
  /** 批注：一个对话气泡 */
  note: <path d="M3 3.5h10v7H8l-3 2.5v-2.5H3z" />,
  /** 别的机器在用这台电脑：一台显示器，屏幕里一个提示符 */
  machine: <path d="M2.5 3h11v7.5h-11zM6 13.5h4M8 10.5v3M4.8 5.4l1.7 1.4-1.7 1.4M8 8.2h2.5" />,
  /** 显示隐藏的：一只眼睛 */
  /** 定时：一个钟面，两根指针 */
  clock: <path d="M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 5v3l2 1.5" />,
  eye: (
    <path d="M2 8c1.6-2.7 3.6-4 6-4s4.4 1.3 6 4c-1.6 2.7-3.6 4-6 4s-4.4-1.3-6-4zM8 9.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z" />
  ),
  /** 建议任务：一盏灯泡 */
  suggest: (
    <path d="M6.3 13.5h3.4M8 2.5a3.8 3.8 0 0 0-2.2 6.9c.4.3.7.8.7 1.3v.8h3v-.8c0-.5.3-1 .7-1.3A3.8 3.8 0 0 0 8 2.5z" />
  ),
}

export type IconName = keyof typeof PATHS

export function Icon({ name, small }: { name: IconName; small?: boolean }) {
  return (
    <svg className={small ? 'ic s14' : 'ic'} viewBox="0 0 16 16" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

/** 折叠箭头。展开与否由父元素的 aria-expanded 决定朝向 */
export function Caret() {
  return (
    <svg className="caret-ic" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  )
}

const glyph = (path: string) =>
  function Glyph() {
    return (
      <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
        <path d={path} />
      </svg>
    )
  }

/** 发送：向上的箭头 */
export const Send = glyph('M8 13V3.5M4 7.5l4-4 4 4')
/** 停止：一个方块 */
export const Stop = glyph('M4.5 4.5h7v7h-7z')
export const Close = glyph('M4 4l8 8M12 4l-8 8')
/** 勾：多选的选项里挑中了 */
export const Check = glyph('M3.5 8.5l3 3 6-7')
export const Plus = glyph('M8 3.5v9M3.5 8h9')
/** 图片：一个画框，里面一道山和一个太阳 */
export const Picture = glyph('M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 1.5-1.5 4 4M10.5 6.2v.1')
/** 归档：一个带盖的盒子 */
export const Archive = glyph('M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3')
/** 设置：一个齿轮——中间一个圈，四周八个齿 */
export const Gear = glyph(
  'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4',
)
/** 设备：一台带底座的显示器 */
export const Machine = glyph('M2.5 3.5h11v7h-11zM5.5 13h5M8 10.5V13')
/** 分叉：一条竖线，半路岔出去一支 */
export const Fork = glyph('M5 3v10M5 9.5c0-2.5 6-2 6-4.5V3')
/** 回退：一个往回拐的箭头 */
export const Rewind = glyph('M4 6.5h5.5a3 3 0 0 1 0 6H6.5M6.5 4L4 6.5 6.5 9')
/** 定时任务：一个钟面，两根指针 */
export const Clock = glyph('M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 5v3l2 1.5')
/** 返回：朝左的尖角 */
export const Back = glyph('M9.5 3.5L5 8l4.5 4.5')
/** 进去看：朝右的尖角。列表的一行整行能点开时放在行尾 */
export const Forward = glyph('M6.5 3.5L11 8l-4.5 4.5')
/** 留意：一个三角，里面一竖一点。只当记号用，是什么事由旁边的信息卡去说 */
export const Notice = glyph('M8 2.5l5.5 10.5h-11zM8 6.5v3M8 11.2v.3')
/** 收到下面去：朝下的尖角 */
export const Down = glyph('M3.5 6l4.5 4.5L12.5 6')
/** 向上：和 Down 相反 */
export const Up = glyph('M3.5 10l4.5-4.5 4.5 4.5')
/** 更多：横着三个点 */
export const More = glyph('M3.5 8h1M7.5 8h1M11.5 8h1')
/** 计划：三行清单，每行前面一个点 */
export const Plan = glyph('M3.5 4.5h.5M6.5 4.5h6M3.5 8h.5M6.5 8h6M3.5 11.5h.5M6.5 11.5h6')
/** 命令：一道斜杠，就是打出来叫命令的那个字 */
export const Slash = glyph('M10.5 2.5l-5 11')
/** 加附件：一枚回形针 */
export const Clip = glyph(
  'M12 7.5l-4.3 4.3a2.3 2.3 0 0 1-3.2-3.2l5-5a1.5 1.5 0 0 1 2.1 2.1L6.8 10.5',
)
/** 带着的一段文字：一张写了几行字的纸 */
export const Snippet = glyph('M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3')
/** 技能：一颗四角的星 */
export const Spark = glyph('M8 2.5l1.4 4.1 4.1 1.4-4.1 1.4L8 13.5 6.6 9.4 2.5 8l4.1-1.4z')
/** 评论：一个对话气泡 */
export const Bubble = glyph('M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2zM5 6.5h6M5 8.5h4')
