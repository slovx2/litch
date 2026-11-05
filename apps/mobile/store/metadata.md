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
成人/医疗/性/暴力/赌博相关内容频率均为无，没有赌博或抽奖箱功能，不选择儿童类别或人工提高分级。
上述答案由 App Store Connect 计算为全球 4+，具体地区以 Apple 生成的评级为准；能力改变时重答。

## 提交前仍须补齐

- 经理审阅文案、地区、三类隐私披露与审核备注。
- 审核联系人的姓名、可接听电话和邮箱；支持/隐私专用邮箱由发行主体确认。
- 隔离演示主机的连接资料、指纹、测试步骤与凭据；不把凭据写进本仓库。
- 内容版权声明由发行主体确认。不得把公共 GitHub 支持地址等同于已经完成所有审核联系信息。
- DSA 未完成期间不向欧盟 27 国分发；首批同时排除中国大陆、俄罗斯、白俄罗斯、阿联酋。
- 加密问卷使用“自行使用标准算法”，法国分发为否；若加入法国或改变加密实现，重做合规判定。

当前仅内部 TestFlight；商店材料及隐私答案保存草稿，不提交 App Store 或外部 Beta 审核，也不点隐私页的“发布”。
