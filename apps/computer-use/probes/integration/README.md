# 后台执行与画中画集成验收

这里编译产品的 Swift 源文件，仅用测试入口替换 `main.swift`。入口只接受
`/tmp/litch-cu-` 开头的状态目录和一次性令牌；正式助手的团队验签没有放宽。
`LITCH_CU_PROBE_NO_PRIVATE=1` 只存在于测试入口，用于验证私有鼠标不可用时的回退。

在仓库根目录、Node 24 环境下构建：

```sh
LITCH_SIGN_IDENTITY=<自己的签名身份> node apps/computer-use/probes/integration/build.mjs
node_modules/.bin/esbuild apps/computer-use/probes/integration/check.mts \
  --bundle --platform=node --format=esm \
  --outfile=apps/computer-use/.artifacts/integration/check.mjs
```

输出 `apps/computer-use/.artifacts/integration/Litch Background Input Probe.app`。
包标识是 `io.github.slovx2.litch.background-input-probe`；由 LaunchServices 独立启动，
不借终端或其他应用的权限。系统设置 → 隐私与安全性中，用户需要为这个探针开启
“辅助功能”和“屏幕与系统音频录制”。真正首次采集还可能弹“直接访问屏幕”的确认；
必须由用户处理。权限预检为 true 不等于实际采集成功，不修改 TCC 绕过授权。

目标窗口来自 `../background/` 的自有 AppKit、Electron 和守卫夹具。先按照该目录说明
构建、启动夹具，再运行：

```sh
node apps/computer-use/.artifacts/integration/check.mjs \
  /tmp/litch-cu-fixtures /tmp/litch-cu-integration-results \
  '<仓库绝对路径>/apps/computer-use/.artifacts/integration/Litch Background Input Probe.app'
```

运行前确认无人使用电脑，并独占 GUI 验收时段。脚本会激活自有夹具，只在这些窗口中
输入测试内容。运行时重新读取权限、责任进程和鼠标能力；正常/私有不可用各一轮，覆盖
中英文逐字符、点击、滚动、前台恢复、固定预览不激活、输入租约互斥、长文本取消。
系统提示出现或前台异常时立即停止，不能代点确认后把失败轮算成通过。

每轮保存 `report.json`、通知摘要和自有窗口截图；图像不含用户页面。临时
`caffeinate -d -i -w <探针 PID>` 在 finally 中退出，并在报告中记录 PID 和退出状态。
探针退出后可撤掉上述两项系统授权。SIP 开启与关闭的证据必须分别记录。

`prepare-fixture.mjs` 用现有假模型夹具生成独立的桌面 UI 验收入口，供真实 Litch
窗口连接；不使用个人模型配置或真实用户状态。UI 验收应另记截图、停止/接管、窗口
移动和缩放、首帧确认、无消费者停流及视觉检查，不能用这里的动作结果代替。
