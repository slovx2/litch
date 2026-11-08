# 人机共用验收

这个入口与产品编译同一份 `ActionContext`、`ForegroundExcursion`、`Input` 和事件监视。
AppKit 目标与守卫均来自本仓库夹具，Electron 始终 `show: false`，不采集其他窗口。
模拟用户的 HID 输入交给已授权的 Peekaboo；必须传 `--no-remote`，不启动远程桥接。
探针自己只用已获辅助功能授权的定向输入；`PostEvent` 预检与实际控件结果分别报告。
没有权限或发现真实用户输入就退出，不弹授权，不读取或改写 TCC。

```sh
LITCH_SIGN_IDENTITY=- node apps/computer-use/probes/background/build.mjs
LITCH_SIGN_IDENTITY=<原有探针签名身份> node apps/computer-use/probes/integration/build.mjs --coexist
LITCH_CU_PEEKABOO=<已授权的 Peekaboo 绝对路径> node apps/computer-use/probes/coexist/wait.mjs
```

探针签名与系统确认见 [测试签名与系统确认](../integration/PERMISSIONS.md)，新测试证书是可选加固。

每组开始前用 `ioreg -c IOHIDSystem` 读取 `HIDIdleTime`，满 60 秒才启动；读取失败不能放行。
等待器每两分钟检查一次，最长两小时，也可用 `LITCH_CU_DEADLINE` 给出更早的绝对截止时间。
`routing` 先验证 Peekaboo 点击进入产品监视并归到正确应用，`collision` 再验当前步骤失败及
下一次动作重试，`electron` 独立测隐藏窗口的公开点击和中英文整串／逐字符候选。
可将组名传给 `wait.mjs` 只重验指定组；`coexist` 是其他应用输入及鼠标移动的共用回归。
非测试输入（包括来源 PID 为 0 的真实 HID 输入）令整组作废并重新等空闲，不计作产品失败。
直接调用 `run.mjs` 同样检查 60 秒门槛；未空闲或本组作废的退出码是 75。

运行器创建隔离 HOME、CODEX_HOME 和 Electron profile，
结果只输出到标准输出；finally 退出自己的夹具并删除临时状态。不会安装或替换正式助手。
通过既要有控件的实际变化，也要有用户事件监视收到模拟输入的证据。
用户点击导致当前前台动作失败后，用新的输入作用域验证同一上下文仍可继续。
隐藏 Electron 的每个候选测三次，同时核对前台与光标；候选无效时不能开启对应产品能力。
候选效果字段 `changed: false` 是不支持的实测结果，不等于验收脚本失败。

这不是 Windows、IME、多显示器、可见 Electron 前台点击或真实用户混合输入的完整验收。
隐藏 Electron 无法代表曾经激活过的浏览器窗口，结果不能外推到所有 Chromium 控件。
