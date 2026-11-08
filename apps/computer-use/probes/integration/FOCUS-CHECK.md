# 前台共存回归

`focus-check.mts` 启动独立签名的产品源码探针以及自有 AppKit 目标、前台守卫。
只操作夹具，不操作用户应用；不修改或替换正式助手。使用隔离 HOME/CODEX_HOME。
原生观察器同时监听 NSWorkspace 激活通知并每 5ms 采样前台 PID 和真实光标位置。
实际控件结果与前台稳定分别断言，前台回退单列，并验证恢复状态。

需要本机已有的 Node 24、Swift 和[测试专用签名证书](PERMISSIONS.md)；不安装依赖。
探针必须已由用户授予辅助功能和屏幕录制权限；新路径首次截图还可能触发系统确认。
脚本不会代点权限提示。当前台出现系统确认/锁屏，或用户在动作中切换前台时立即停止。
开始前最多等两分钟，等到真实 HID 空闲三秒才创建并激活测试窗口。
光标变化同样会令后台动作检查失败；先检查用户活动，不要直接归因到产品。

```sh
LITCH_SIGN_IDENTITY=- node apps/computer-use/probes/background/build.mjs
LITCH_CU_SIGN_IDENTITY='<测试证书的 SHA-1>' node apps/computer-use/probes/integration/build.mjs
node --import tsx apps/computer-use/probes/integration/focus-check.mts /绝对路径/after.json
# 只在探针内注入一次活动版本变化，不发送全局键鼠事件：
LITCH_CU_PROBE_INTERRUPT_SELFTEST=1 node --import tsx apps/computer-use/probes/integration/focus-check.mts /绝对路径/retry.json
```

矩阵包含观察、元素/坐标单击、双击、右击、输入、普通键、Command 菜单快捷键、
滚动、设值、选字、拖拽、无匹配菜单的快捷键回退，以及调用正式批量编排器的 run_actions。
Command+A 要完成八字符全选；拖拽要完成六字符选择；点击计数、滚动位置、输入内容、
选择范围都检查实际结果。后台动作要求全过程无前台切换、无真实光标移动。
回退动作允许切换，但必须恢复守卫；取消拖拽还检查系统左键松开、目标能响应后续命令。
真实用户接管会使该轮验收作废。

`LITCH_CU_RECORD_BASELINE=1` 只记录旧版的前台变化与动作错误，不据此判定回归通过。
用已提交源码的导出副本做对照时，build.mjs 接受 `LITCH_CU_PRODUCT_ROOT`（包含
Package.swift、Sources、Tests 的导出目录）和 `LITCH_CU_PROBE_OUTPUT`（输出 .app 路径）；
运行器通过 `LITCH_CU_PROBE_APP` 选择该探针。两版必须使用同一份夹具与运行器。
输出保留原生事件、动作结果、前台变更、光标稳定性及临时目录；退出所有自有进程，
保留临时目录方便核对证据。不要把有系统确认或真实用户介入的运行算成产品失败。

此矩阵不代表 Chromium、跨应用拖放、跨 Space、多屏、IME 或 Windows 真机验收。
Windows 当前只减少前台输入结束后不必要的等待，不能把 SendInput 当成后台定向输入。
