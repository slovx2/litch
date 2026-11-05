# Litch iOS 支持 / Support

Litch 是免费、开源的远程开发客户端，由数能觉醒（深圳）科技有限公司（Shuneng Awakening (Shenzhen) Technology Co., Ltd）发布。

- [提交问题或获取帮助 / Get help](https://github.com/slovx2/litch/issues)
- [使用说明 / User guide](https://github.com/slovx2/litch/blob/main/skills/litch-manual/references/phones.md)
- [隐私政策 / Privacy policy](ios-privacy.md)
- [源代码 / Source code](https://github.com/slovx2/litch)

隐私请求（包括查询、访问或删除数据）和内容举报，请发送邮件至 [admin@datawake.cc](mailto:admin@datawake.cc)。GitHub Issues 仍可用于公开的问题反馈。说明 iOS 版本、Litch 版本、设备型号、操作步骤与错误提示即可；请先删除截图中的地址、账户和私人会话，不要在 Issues 上传 SSH 私钥、密码、验证码、配对二维码、API key 或其他敏感信息。

For privacy requests, including inquiries, access or deletion requests, and content reports, email [admin@datawake.cc](mailto:admin@datawake.cc). GitHub Issues remain available for public feedback. Include your iOS version, Litch version, device model, steps and the error message. Issues are public: remove private content from screenshots and never post SSH keys, passwords, verification codes, pairing QR codes, API keys or other sensitive information.

## 连接问题 / Connection problems

先确认电脑或服务器上的 Litch 设备服务和 SSH 正在运行，手机能访问配置的地址。局域网连接需在同一可达网络；使用内嵌 Tailscale 时，两端须有相应网络访问权限。不要通过关闭主机指纹校验来解决连接错误。

Check that the Litch device service and SSH are running and the configured address is reachable from your phone. For embedded Tailscale, verify that your network policy permits the connection. Do not disable host-key checks to work around a connection error.

iOS 在后台可能暂停连接，返回前台后恢复。iOS 应用更新通过 App Store 或 TestFlight 提供。

iOS may pause connections in the background and resume them in the foreground. App updates are delivered through the App Store or TestFlight.
