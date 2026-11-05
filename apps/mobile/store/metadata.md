# App Store 文案草稿（提交前审阅）

## en-US

- Name: Litch — Remote Workspace
- Subtitle: Your remote coding workspace
- Promotional text: Follow your coding sessions, review changes and respond to approvals from your iPhone. Connect to the computers and tools you already use.
- Keywords: ssh,terminal,coding,developer,remote,workspace,git,assistant
- Primary category: Developer Tools
- Support: https://github.com/slovx2/litch/blob/main/docs/ios-support.md
- Privacy: https://github.com/slovx2/litch/blob/main/docs/ios-privacy.md

Litch brings sessions from your computers and coding tools together on your iPhone.

Connect to your own computers over SSH. Read conversations, send instructions, respond to approval requests, inspect files and diffs, and use a remote terminal. Optional embedded Tailscale helps reach devices on your private network.

Litch is free and open source. You provide the computer, install the Litch device service and configure the coding tools and model services you want to use. Third-party tools or services may require separate accounts or subscriptions.

Commands and coding tools run on your remote computer. iOS may pause connections while the app is in the background; return to the app to reconnect.

## 简体中文

- 名称：Litch — Remote Workspace
- 副标题：连接你的远程开发工作区
- 推广文本：在 iPhone 上查看编程会话、审阅修改并处理审批，连接你已有的电脑和开发工具。
- 关键词：SSH,终端,编程,开发,远程,工作区,Git,助手
- 主类别：开发者工具

Litch 将多台电脑、多个编程工具的会话汇集到你的 iPhone。

通过 SSH 连接自己的电脑，阅读会话、发送指令、处理审批、查看文件与差异，并使用远程终端。可选的内嵌 Tailscale 帮助你访问私有网络中的设备。

Litch 免费且开源。你需要准备电脑、安装 Litch 设备服务，并配置所需的编程工具和模型服务。第三方工具或服务可能要求独立账户或订阅。

命令和编程工具在远程电脑上运行。iOS 可能在应用进入后台时暂停连接，返回应用后可恢复。

## Review Notes 草稿

Litch is an open-source remote development client. It connects to a user-configured computer over SSH. Shell commands and coding harnesses execute on that computer, not on iOS. The app does not download or install native harness executables on iOS. Its bundled WebViews render the terminal and file content.

Optional Tailscale uses an embedded userspace stack for Litch's own connections. It does not install a system VPN profile or route other apps' traffic. The app discloses control-plane metadata processing and provides sign-out and local node clearing. We have not requested Network Extension or background VPN capabilities.

iOS updates are delivered through the App Store/TestFlight. There are no paid features or in-app purchases in Litch. Users configure their own external computers, harnesses and model-provider accounts.

Before submission, attach the dedicated review environment's connection instructions, host fingerprint, credentials and testing steps. Do not submit this paragraph as a placeholder. Provide working review contact details and keep the environment available throughout review.
