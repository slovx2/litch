# 人机共用验收

这个入口与产品编译同一份 `ActionContext`、`ForegroundExcursion`、`Input` 和事件监视。
AppKit 目标与守卫均来自本仓库夹具，Electron 始终 `show: false`，不采集其他窗口。
模拟用户的 HID 输入交给已授权的 Peekaboo；必须传 `--no-remote`，不启动远程桥接。
探针自己只用已获辅助功能授权的定向输入；`PostEvent` 预检与实际控件结果分别报告。
没有权限或发现真实用户输入就退出，不弹授权，不读取或改写 TCC。

```sh
LITCH_SIGN_IDENTITY=<本机签名身份> node apps/computer-use/probes/background/build.mjs
LITCH_SIGN_IDENTITY=<本机签名身份> node apps/computer-use/probes/integration/build.mjs --coexist
LITCH_CU_PEEKABOO=<已授权的 Peekaboo 绝对路径> node apps/computer-use/probes/coexist/run.mjs
```

只在暂时无人使用电脑时运行。运行器创建隔离 HOME、CODEX_HOME 和 Electron profile，
结果只输出到标准输出；finally 退出自己的夹具并删除临时状态。不会安装或替换正式助手。
通过既要有控件的实际变化，也要有用户事件监视收到模拟输入的证据。
用户点击导致当前前台动作失败后，用新的输入作用域验证同一上下文仍可继续。
隐藏 Electron 的公开点击候选每条测三次；候选无效时不能开启对应产品能力。

这不是 Windows、IME、多显示器、可见 Electron 前台点击或真实用户混合输入的完整验收。
隐藏 Electron 无法代表曾经激活过的浏览器窗口，结果不能外推到所有 Chromium 控件。
