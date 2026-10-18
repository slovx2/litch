// 测量用的开关，由链接参数设置（App.tsx）。只在进详情页之前改，单元格不会因为它重画。
// 默认值是 60 秒长回答流式输出（场景 t1）比下来最好的一组。
//   render=md     正文用 Markdown 组件（默认）
//   render=plain  正文用普通 Text：对照组，用来分清卡顿来自 Markdown 绘制还是列表与模拟器本身
//   seal=<字数>   流式文字攒到多少字封口成一行（core/blocks.ts）。越小，正在长的那一块越短，每次重排越便宜
//   pace=<毫秒>   流式时两次交给界面之间至少隔多久（core/session-store.ts），0 是每帧都交
//   freeze=1      写完的块排好版后钉死高度（detail/cells.tsx）
//   tail=open|whole  尾巴只放正在长的那一块，还是整条正在流式的回答（core/session-store.ts）
//   keyboard=sticky|chat  变体 A 跟键盘的做法：整个对话区和输入区一样跟着键盘平移（detail/DetailScreen.tsx），
//                 还是交给键盘库的聊天滚动组件（KeyboardChatScrollView）
//   markers=1     画两条测量用的标记线（measure/README.md）：内容末尾一条洋红、输入区上沿一条青色
export const experiment: {
  markers: boolean
  render: 'md' | 'plain'
  seal: number
  pace: number
  freeze: boolean
  tail: 'open' | 'whole'
  keyboard: 'sticky' | 'chat'
} = {
  markers: false,
  render: 'md',
  seal: 300,
  pace: 100,
  freeze: true,
  tail: 'whole',
  keyboard: 'sticky',
}
