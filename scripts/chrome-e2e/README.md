# Chrome 自动验收

在 macOS、Node 24、Go 和仓库依赖已安装的环境运行：

```sh
npm run client:check:chrome
```

脚本从源码构建固定 ID 的未打包扩展和 Native Messaging Go 宿主，默认使用本机 Playwright 缓存中的 Chrome for Testing。也可显式设置 `LITCH_CHROME_BINARY` 为已安装的 Chrome for Testing 可执行文件；不会下载浏览器，也不会使用日用 Chrome。

自动安装先在隔离的 `chrome://extensions` 开启开发者模式，再经仅测试实例启用的 DevTools `Extensions.loadUnpacked` 加载。没有开启开发者模式时 Chrome 会在 reload 后禁用未打包扩展，验收不跳过这一步。

每次创建独立的 HOME、CODEX_HOME、user-data-dir 和 NativeMessagingHosts。浏览器使用 mock keychain / basic password store；不读取个人模型凭据，不访问真实钥匙串。端口动态选择并核对监听 PID，禁止 9333。成功失败都终止浏览器、断开宿主、清理临时目录。退出码非零表示失败，报告与截图保存在 `.local/chrome-e2e/`。

场景用回环 HTTP 夹具提供登录 Cookie、弹窗、跨来源 iframe 和输入控件；操作经正式 `ChromeExecutor → ChromeBridge → Go Native Messaging → MV3` 路径，审批由脚本答复。CDP 只用于验收侧检查 PID、改变缩放和触发扩展生命周期，不替代模型业务工具。脚本化的 remote invocation 只验证控制端语义，不能代替真实 SSH 设备验收。

默认 headless，不占前台。仅在已获得前台时段后可运行：

```sh
LITCH_CHROME_GUI_SLOT=approved npm run client:check:chrome -- --shown
```

正式版 Chrome 手动“加载已解压的扩展程序”、DevTools UI 与 Litch 设置页视觉验收仍是单独的有窗口项目。正式版不支持命令行自动加载未打包扩展，不能用这条脚本宣称已验证其安装引导。
