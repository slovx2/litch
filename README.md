# Litch Automation

Computer Use、内置浏览器与 Chrome 控制的 MIT 代码库。五个 npm 包使用独立 semver，首版为 0.x；提供 Swift/Rust 与 Go Native Messaging host 源码及编译入口。原生签名、公证、应用打包和分发均由宿主负责，不发布预编译 helper。

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix packages/browser
npm run build
npm run typecheck
npm test
npm run check:packages
swift test --package-path apps/computer-use
go test ./chromebridge ./internal/hostplatform
```

macOS 编译：`node apps/computer-use/build.mjs`。Windows：在 `apps/computer-use-win` 显式提供五个 CU_* 构建变量后运行 `cargo build --locked --release --target x86_64-pc-windows-msvc`。宿主身份在构建阶段固定，正式运行不得由模型改写。

隔离测试启动 Chromium 或 Electron 时，使用 `scripts/chromium-test-args.mjs` 的 `withChromiumTestArgs(args)`：统一传入 mock keychain 和 basic password store，避免测试访问系统钥匙串。Playwright 的 `args` 和直接启动进程共用此函数；`npm run check` 包含启动参数的静态检查及回归测试。产品宿主不使用这个测试 helper。

Litch 通过 subtree 源码集成；其他宿主可安装精确 npm 包并从对应源码 tag 编译 helper。npm 默认入口不查个人 HOME、不登记系统宿主、不下载 helper。
