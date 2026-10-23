// 预览首页自己的样式（只管屏外面这一圈，屏里是应用自己的样子）。跟着系统的明暗
export const CSS = `
.pv {
  --bg: #e9eaee; --side: #f6f7f9; --ink: #1b1c22; --ink2: #5a5d69; --ink3: #8a8d98;
  --line: rgba(27,28,34,.12); --sel: rgba(27,28,34,.08); --accent: #3e46c8;
  position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--ink);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .pv { --bg: #0d0e12; --side: #15161c; --ink: #e6e7ee; --ink2: #a3a6b4; --ink3: #737684;
        --line: rgba(230,231,238,.12); --sel: rgba(230,231,238,.08); --accent: #9ca0ff; }
}
.pv button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.pv-side { width: 300px; flex: none; display: flex; flex-direction: column; background: var(--side);
  border-right: 1px solid var(--line); min-height: 0; }
.pv-head { padding: 16px 16px 8px; }
.pv-head h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.pv-head p { margin: 0; color: var(--ink2); font-size: 12px; }
.pv-tools { display: flex; flex-direction: column; gap: 6px; padding: 8px 16px; }
.pv-seg-row { display: flex; align-items: center; gap: 8px; }
.pv-label { width: 32px; color: var(--ink3); font-size: 12px; }
.pv-seg { display: flex; margin: 0; padding: 0; min-width: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.pv-seg button { padding: 3px 9px; font-size: 12px; color: var(--ink2); }
.pv-seg button + button { border-left: 1px solid var(--line); }
.pv-seg button[aria-pressed="true"] { background: var(--sel); color: var(--ink); font-weight: 600; }
.pv-search { margin: 8px 16px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: transparent; color: var(--ink); font: inherit; }
.pv-list { flex: 1; overflow-y: auto; padding: 0 8px 16px; }
.pv-list h2 { margin: 12px 8px 4px; font-size: 11px; font-weight: 600; color: var(--ink3); letter-spacing: .06em; }
.pv-list button { display: flex; flex-direction: column; width: 100%; text-align: left; padding: 6px 8px; border-radius: 6px; }
.pv-list button:hover { background: var(--sel); }
.pv-list button[aria-current="true"] { background: var(--sel); box-shadow: inset 2px 0 0 var(--accent); }
.pv-list b { font-weight: 500; }
.pv-list span { color: var(--ink3); font-size: 12px; }
.pv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pv-bar { display: flex; align-items: baseline; gap: 10px; padding: 14px 24px; border-bottom: 1px solid var(--line); }
.pv-bar span { color: var(--ink2); }
.pv-bar button { margin-left: auto; color: var(--accent); }
.pv-phones { flex: 1; overflow: auto; display: flex; flex-wrap: wrap; gap: 32px; padding: 24px; align-items: flex-start; }
.pv-phone { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.pv-phone iframe { border: 0; border-radius: 18px; background: #000;
  box-shadow: 0 0 0 8px #1c1d22, 0 0 0 9px rgba(127,127,127,.35), 0 18px 40px rgba(0,0,0,.25); margin: 9px; }
.pv-phone figcaption { color: var(--ink3); font-size: 12px; text-align: center; }
.pv-phone a { color: var(--accent); }
`
