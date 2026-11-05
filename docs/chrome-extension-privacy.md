# Litch Browser — Privacy Policy / 隐私政策

Last updated / 更新日期: 2026-11-05

Litch Browser is a companion extension for the free, open-source
[Litch desktop app](https://github.com/slovx2/litch). It lets coding agents operate
Chrome tabs and websites that you approve.

## Information handled by the extension

- Titles and URLs of open tabs, after you allow the agent to access the Chrome instance.
- Content of approved pages: text, accessibility information, screenshots, console
  messages, and the input and actions requested by your agent. Depending on the page
  you approve, this content may include personal information or private communications.
- A random Chrome instance identifier, temporary control state, and tab/group recovery
  records. Recovery records include tab and group identifiers, group names and colors,
  tab positions and pinned state, and Litch session identifiers and a short session title.
  They let the extension restore tabs after control ends or the extension restarts.

The extension does not access Chrome's saved password store, cookies API, bookmarks,
browsing history database, or download history. It does not record your own keystrokes
or clicks. This does not mean that an approved page is anonymous: the agent can see
the page content available in your signed-in browser session.

## Where information goes

The extension communicates with Litch on the same computer through Chrome Native
Messaging. It has no collection server and does not send telemetry to the Litch developers.

Litch passes requested page information to the agent in your session. If you use a
cloud AI model, that information is sent to the provider you configured, under its
terms and privacy policy. If your session runs on another computer connected to Litch,
the information travels to that computer through the configured SSH connection.
Normal website requests continue to be handled by Chrome and the websites you visit.

The Litch developers do not receive or sell this browser information through the
extension. Browser information is used to perform the browser assistance you request,
not for advertising or creditworthiness decisions.

## Storage and retention

The extension keeps its random instance identifier and tab/group recovery records in
Chrome's local extension storage. Recovery records are removed after successful
restoration; failed restoration can be retried later. Short-lived control state also
uses extension session storage and memory. Recent console messages are held in memory
for controlled tabs and cleared when their control ends.

Page content returned to an agent can remain in that agent's conversation history,
tool results, or files you ask it to create. Retention on a remote device or at a model
provider is governed by your agent, device, and provider settings. Removing this
extension does not delete those separate records.

## Your choices

Chrome control is off by default in Litch. You approve access to the Chrome instance
and to website origins, and explicitly allow the agent to claim your existing tabs.
Signing in to Chrome websites is performed by you; agent observation and control pause
during that sign-in flow. You can stop control with the extension's toolbar icon,
Chrome's debugging bar, or Litch's Chrome settings. Uninstalling the extension removes
its Chrome-managed storage; turning off Chrome control stops new agent access.

## Contact

For privacy questions, contact the project through
[Litch's issue tracker](https://github.com/slovx2/litch/issues).
Issues are public: do not include passwords, tokens, private page content, or identity documents.

---

## 中文说明

Litch Browser 是免费开源桌面应用 Litch 的配套扩展，让编码代理操作你批准的 Chrome 标签与网站。

### 扩展处理的信息

- 允许代理访问 Chrome 实例后，扩展可提供已打开标签的标题与网址。
- 经批准页面的文字、可访问性信息、截图、控制台消息，以及代理请求执行的输入和操作。
  页面内容可能包含个人信息或私人通信，取决于你批准代理访问的网站。
- Chrome 实例的随机标识、临时控制状态，以及恢复标签和标签组所需的记录：标签及分组标识、
  分组名称和颜色、标签位置和固定状态、Litch 会话标识及短标题。

扩展不读取 Chrome 密码库、Cookie API、书签、浏览历史数据库或下载历史，不记录你本人的
按键或点击。但经批准的页面仍可能显示你登录后才能看到的内容，代理能够读取这些页面内容。

### 信息流向与保存

扩展通过 Native Messaging 与同一电脑的 Litch 通信，没有自己的数据收集服务器，也不向
Litch 开发者发送遥测。Litch 将请求的页面信息交给当前代理；使用云端模型时，内容会发送给
你配置的模型服务商，适用该服务商的条款和隐私政策。会话运行在远程设备时，内容经已配置的
SSH 连接传到该设备。网页本身的网络请求仍由 Chrome 和相应网站处理。

Litch 开发者不通过本扩展接收或出售这些浏览信息。信息用于你请求的浏览器辅助操作，
不用于广告或信用评估。

随机实例标识和标签恢复记录保存在扩展本地存储中；恢复成功后删除恢复记录，失败时可能稍后
重试。临时控制状态还使用扩展会话存储与内存。受控标签近期的控制台消息保存在内存中，
结束控制时清除。传给代理的内容可能留在会话历史、工具结果或你要求创建的文件中；
远程设备、代理和模型服务商各自的留存取决于相应设置，卸载扩展不会删除这些独立记录。

### 你的控制权

Litch 默认关闭 Chrome 控制。访问 Chrome 实例与网站来源需要批准，认领你已有的标签需要
明确许可。Chrome 网站登录由你本人完成，登录流程期间暂停代理观察与控制。
你可以通过扩展图标、Chrome 调试提示条或 Litch 的 Chrome 设置停止控制。
卸载扩展会删除 Chrome 管理的扩展存储；关闭 Chrome 控制会停止新的代理访问。

隐私问题请通过 [Litch 问题反馈](https://github.com/slovx2/litch/issues) 联系项目。
反馈内容公开，请勿附上密码、令牌、私人页面内容或身份证明文件。
