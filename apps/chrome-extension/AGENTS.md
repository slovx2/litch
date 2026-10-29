# Chrome 扩展

- 正式路径只通过 Native Messaging 接受 Litch 请求，不接受网页消息；来源、租约、文档代次在每次观察和输入前后复核。
- 光标只在 isolated world 挂载公共 renderer；动画回执不授予输入权限，派发前必须再次检查租约和文档。
- 固定 ID 来自 `identity.json` 的公钥；构建入口 `../desktop/scripts/build-chrome.mjs`。不保存私钥，不要求 host_permissions。
- 自动验收和夹具用法见 `../../scripts/chrome-e2e/README.md`；正式 Chrome 安装与视觉检查另需隔离 profile 和前台时段。
