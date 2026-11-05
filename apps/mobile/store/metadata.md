# App Store 文案草稿（提交前审阅）

## en-US

- Name: Litch — Remote Workspace
- Subtitle: SSH, terminal & coding agents
- Promotional text: Follow your coding sessions, review changes and respond to approvals from your iPhone. Connect to the computers and tools you already use.
- Keywords: ssh,terminal,coding,developer,remote,workspace,git,assistant
- Primary category: Developer Tools
- Support: https://github.com/slovx2/litch/blob/main/docs/ios-support.md
- Privacy: https://github.com/slovx2/litch/blob/main/docs/ios-privacy.md
- Review/support email: admin@datawake.cc

Litch is an SSH client for your own development computers and servers. Follow AI coding sessions, review files and changes, respond to approvals, and use a remote terminal from your iPhone.

Connect to your own computers over SSH. Read conversations, send instructions, respond to approval requests, inspect files and diffs, and use a remote terminal. Optional embedded Tailscale helps reach devices on your private network.

Litch is free and open source. You provide the computer, install the Litch device service and configure the coding tools and model services you want to use. Third-party tools or services may require separate accounts or subscriptions.

Commands and coding tools run on your remote computer. iOS may pause connections while the app is in the background; return to the app to reconnect.

## 简体中文

- 名称：Litch — Remote Workspace
- 副标题：SSH 终端与远程编程助手
- 推广文本：在 iPhone 上查看编程会话、审阅修改并处理审批，连接你已有的电脑和开发工具。
- 关键词：SSH,终端,编程,开发,远程,工作区,Git,助手
- 主类别：开发者工具
- 审核联系／支持邮箱：admin@datawake.cc

Litch 是连接你自己的开发电脑与服务器的 SSH 客户端。在 iPhone 上查看 AI 编程会话、审阅文件与修改、处理审批，并使用远程终端。

通过 SSH 连接自己的电脑，阅读会话、发送指令、处理审批、查看文件与差异，并使用远程终端。可选的内嵌 Tailscale 帮助你访问私有网络中的设备。

Litch 免费且开源。你需要准备电脑、安装 Litch 设备服务，并配置所需的编程工具和模型服务。第三方工具或服务可能要求独立账户或订阅。

命令和编程工具在远程电脑上运行。iOS 可能在应用进入后台时暂停连接，返回应用后可恢复。

## Review Notes 草稿

Litch is a free, open-source SSH and protocol client, not a desktop-screen mirroring service. Its native interfaces display coding sessions, files, diffs, approvals and manager boards. Shell commands and coding tools execute on the user-configured remote computer, not on iOS. The app does not download replacement application code or install local coding tools. Its bundled WebViews render terminal and document content.

Optional Tailscale uses an embedded userspace stack for this app's SSH connections. It does not install a system VPN profile or route other apps' traffic. Before sign-in, the app explains node and network metadata processing, links to the privacy policy and allows cancellation. Direct SSH needs no Tailscale login. Sign-out and local node clearing are available. We have not requested Network Extension or background VPN capabilities.

AI content comes from the model services configured by the user on their remote computer. Before AI actions, Litch requests data-sharing consent for messages, attachments and project context read by the remote agent. Consent is scoped to the device and reported provider configuration; changes require confirmation. Unreported provider details are identified as unknown and permission is not saved. Settings includes “Feedback or report content”, which opens email to admin@datawake.cc, and a consent withdrawal control. Litch has no public feed or user-to-user chat. The intended App Store age rating is 16+. This does not claim that arbitrary remote AI output is globally filtered.

This consent covers actions initiated from the phone. Agents running on the remote computer call services according to the user's configuration there, under the user's control on that computer. The phone does not intercept those autonomous requests. Withdrawing phone consent does not stop existing remote tasks or delete content already sent.

iOS updates are delivered through the App Store/TestFlight. There are no paid features or in-app purchases in Litch. Users configure their own external computers, harnesses and model-provider accounts.

Review contact: admin@datawake.cc. The isolated review environment uses fictional project data and a configured model service. Supply the verified host, port, user, workspace, host fingerprint, review-only private key and test steps in the private App Review Information fields/attachment; keep the environment available throughout review. This preparation paragraph must be replaced with those verified instructions before submission.

### 中文审核说明

Litch 是免费开源的 SSH 与协议客户端，不是远程桌面镜像服务。手机用原生界面展示编程会话、文件、差异、审批与经理看板；命令和编程工具在用户配置的远程电脑执行。iOS 不下载替换应用代码，不安装本地编程工具，终端与文档查看器使用随包网页资源。

内嵌 Tailscale 仅为本 App 的 SSH 提供网络路径，不安装系统 VPN 配置，不转发其他 App 流量。登录前说明节点和网络元数据处理、提供隐私政策链接及取消；普通 SSH 不要求登录 Tailscale。设置支持退出及清除本机节点。

AI 内容来自用户在远程电脑自选的模型服务。AI 操作前说明消息、附件和代理读取的项目上下文去向并征求同意；记录按设备和已上报的供应商配置保存，变更后重新确认。供应商未完整上报时明确提示未知且不保存本次许可。设置提供“反馈或举报内容”（admin@datawake.cc）及撤回同意。无公共内容动态或用户间聊天，商店目标年龄分级为 16+，不宣称对任意远程模型输出已实现全局过滤。

同意机制只覆盖从手机发起的操作。远程机器上的代理按用户在该机器上的配置调用服务，由用户在远程设备控制；手机不拦截其自主请求。撤回手机同意不会停止已有远程任务或删除已传出的内容。

审核联系邮箱：admin@datawake.cc。隔离演示环境的真实连接资料、专用私钥与测试步骤仅在非公开审核字段/附件提供；本文件不保存凭据。

## 隐私问卷草稿

选择收集数据，不做跨 App 跟踪。以下三项均用于 App 功能、与用户身份关联、不用于追踪：

| 数据类型 | 数据流依据 |
| --- | --- |
| 设备 ID | 可选 Tailscale 控制服务登记节点标识、公钥与用户的设备 |
| 其他数据类型 | 节点名、操作系统与客户端版本、网络地址等连接元数据 |
| 其他使用数据 | 控制/中继服务处理连接时间、连接记录与流量统计；客户端禁用日志上传不等于服务端不保留必要记录 |

依据：[Tailscale 隐私政策](https://tailscale.com/privacy-policy) 的 Tailscale Solution Information。
仅访问外部注册网站时填写的姓名/邮箱，与从 App 发送的数据分开判断；不把其他产品 Aperture/PAM 的内容采集套到本 App。
本机私钥、二维码识别和生物识别模板不作为离机收集声明。用户选择的 SSH 主机及其模型服务由用户配置，政策说明其数据去向。
原生隐私清单与服务端披露范围应分别复核；不能仅照 SDK 清单决定商店答案。

## 年龄分级草稿

当前 App 内没有家长控制、年龄验证、任意网页浏览、公共用户内容分发、社交动态、用户间聊天或广告。
外部链接交给系统浏览器；WebView 仅用于随包终端与文件展示。私有编程会话不等于公共内容社区。
发布目标年龄分级为 **16+**；按实际可出现内容重审问卷并按 Apple 提供的方式提高分级，不虚构成人内容频率，不选择儿童类别。16+ 不替代内容与隐私要求，具体地区以 Apple 生成的评级为准。
App Store Connect 当前旧草稿尚未更新；代码集成、准备正式提交时统一更新问卷与商店材料。本轮不修改后台问卷。

## 提交前仍须补齐

- 经理审阅文案、地区、三类隐私披露与审核备注。
- 审核联系人姓名与可接听电话仍须填写；审核联系、隐私请求及内容举报邮箱已确定为 admin@datawake.cc。公开 Issues 不接收敏感资料。
- 隔离演示主机的连接资料、指纹、测试步骤与凭据；不把凭据写进本仓库。
- 内容版权声明由发行主体确认。不得把公共 GitHub 支持地址等同于已经完成所有审核联系信息。
- DSA 未完成期间不向欧盟 27 国分发；首批同时排除中国大陆、俄罗斯、白俄罗斯、阿联酋。
- 加密问卷使用“自行使用标准算法”，法国分发为否；若加入法国或改变加密实现，重做合规判定。

当前仅内部 TestFlight；商店材料及隐私答案保存草稿，不提交 App Store 或外部 Beta 审核，也不点隐私页的“发布”。
