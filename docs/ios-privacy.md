# Litch iOS 隐私政策 / Privacy Policy

更新日期 / Last updated: 2026-11-05

## 中文

本政策适用于由数能觉醒（深圳）科技有限公司（Shuneng Awakening (Shenzhen) Technology Co., Ltd）发布的 Litch iOS 应用。Litch 是免费、开源的远程开发客户端，连接您选择的计算机和服务。

### 您的设备和内容

- 设备地址、用户名、偏好、会话摘要和待发送内容保存在应用本地存储中。SSH 私钥保存在 iOS 安全存储中，用于验证连接；SSH 私钥不会作为会话内容上传。
- 您发送的消息、文件、图片、终端输入和审批操作会传到您选择的远程计算机。计算机上的 harness、模型供应商和工具可能继续处理这些内容；其保存、使用和删除方式由您或相应服务提供方决定。
- iOS 在首次启动时告知数据将交给您选择的远程电脑及其配置的第三方 AI 服务，并请求明确同意。该许可涵盖之后选择的设备、工具和供应商，保存至您在设置中撤回；升级及配置变化不重问。旧版已保存的许可沿用。不同意时不执行 AI 操作，保留草稿并提供查看告知的入口。Android 不显示此同意框；远程机器上的代理仍按您在该机器上的配置调用服务，由您在远程设备上控制，手机不拦截这些自主请求。撤回手机端同意不会停止已经运行的远程任务，也不会删除已传出的内容。
- Litch 的发布者不运营用于集中收集这些远程会话内容的 Litch 云端会话服务。应用没有用于跨应用广告跟踪的 SDK，也不出售用户数据。
- 文件或消息内的远程资源可能向资源提供者发起网络请求。打开外部网页后，该网站适用自己的隐私政策。

### 可选的内嵌 Tailscale

直接 SSH 连接不要求登录 Tailscale。您选择启用内嵌 Tailscale 后，选定的控制服务器会处理建立和管理网络所需的节点标识、节点名称、网络地址、公钥及相关连接元数据；这些信息可能与您的账户关联。中继服务器传输加密流量。不要把“加密流量”理解为控制服务器不接收网络元数据。

使用 Tailscale 官方服务时，请同时阅读 [Tailscale 隐私政策](https://tailscale.com/privacy-policy)。使用其他控制服务器时，其运营方决定相应的数据处理和保留规则。Litch 关闭内嵌 Go 客户端的日志上传；这不会关闭服务端必要的处理或服务端日志。

节点秘密存放在本机 Keychain，不通过 JavaScript 层传递，不参加 iCloud 钥匙串同步。节点状态目录排除备份。SSH 凭据不发送给 Tailscale 控制服务器。此功能只为 Litch 自身连接提供网络路径，不接管其他 App 的网络流量。

### 系统权限

- 相机：由您发起扫描设备配对二维码时使用。
- 本地网络：连接您在局域网中的计算机。
- Face ID / Touch ID：由系统确认敏感审批；Litch 不获取生物特征模板。
- 照片、文件和剪贴板：在您选择附件、导入连接资料或使用复制粘贴功能时处理相应内容。

### 保留、删除和您的选择

您可以移除已添加的设备及其本地会话索引，并管理已保存的 SSH 钥匙。请在远程计算机撤销不再使用的手机授权。远程会话和文件需在保存它们的计算机或服务中删除；移除手机上的设备不会替您删除远端资料。

Tailscale 设置提供退出及清除本机节点身份的操作；原节点记录还需在相应控制服务器的管理台删除。iOS Keychain 项目不应被假定会随卸载应用自动删除。系统备份及第三方服务中的副本受各自设置和保留政策控制。

### 联系与政策更新

隐私请求（包括查询、访问或删除数据）和内容举报，请发送邮件至 [admin@datawake.cc](mailto:admin@datawake.cc)。一般支持问题可查看 [Litch 支持页](ios-support.md)。GitHub issues 仍可用于公开的问题反馈，请勿提交私钥、验证码、个人文件、完整会话或其他敏感资料。您主动在 GitHub 提交的内容由 GitHub 按其政策保存。

政策修改会在本页更新日期和内容。影响数据处理的重要变更会随应用版本说明披露。

## English

This policy covers the Litch iOS app published by Shuneng Awakening (Shenzhen) Technology Co., Ltd. Litch is a free, open-source client for computers and services you choose.

### Your devices and content

Device addresses, usernames, preferences, session summaries and pending inputs are stored locally. SSH private keys are kept in iOS secure storage for authentication, rather than uploaded as session content.

Messages, attachments, images, terminal input and approval actions are sent to your selected computer. Harnesses, model providers and tools on that computer may process the content further. You or those service providers control its retention and deletion. The publisher does not operate a centralized Litch cloud service collecting these sessions. The app has no cross-app advertising tracking SDK and does not sell user data.

On first launch, iOS explains that data goes to your selected remote computer and its configured third-party AI services and requests explicit consent. Consent covers devices, tools and providers you select later, remains saved until withdrawn in Settings, and is not requested again after upgrades or configuration changes. Previously saved consent is retained. If you decline, AI actions are not performed; drafts are kept and a review entry is provided. Android does not show this dialog. Agents on the remote machine continue to call services according to your configuration there; you control those agents on that machine. The phone does not intercept their autonomous requests. Withdrawing consent on the phone does not stop remote tasks already running or delete content already sent.

Remote resources referenced in content may contact their providers. External websites have their own privacy policies.

### Optional embedded Tailscale

Direct SSH does not require Tailscale. If you enable embedded Tailscale, your selected control server processes node identifiers, names, network addresses, public keys and related connection metadata to manage connections. This information may be linked to your account. Relay servers carry encrypted traffic; encryption does not mean control-plane metadata is absent.

The official service is covered by the [Tailscale Privacy Policy](https://tailscale.com/privacy-policy). Other control servers have their own operators and retention practices. Litch disables log uploads in its embedded Go client; necessary server-side processing and server logs are separate.

Node secrets are kept in the device Keychain, are not passed through JavaScript, and do not sync through iCloud Keychain. The node state directory is excluded from backups. SSH credentials are not sent to the control server. This network path serves Litch connections and does not route other apps’ traffic.

### Permissions and choices

The camera scans pairing QR codes at your request. Local network access connects to your computers. Face ID or Touch ID confirms sensitive approvals through iOS; the app does not receive biometric templates. Selected photos, files and clipboard contents are handled when you use attachment, import or copy/paste features.

You can remove configured devices and their local session indexes, manage saved SSH keys, and revoke phone access on the remote computer. Removing a device on the phone does not delete remote sessions or files. Delete those at their source.

Tailscale settings allow sign-out and clearing the local node identity. Remove the old node separately in the control server’s admin console. Do not assume uninstalling the app deletes Keychain entries. System backups and third-party copies follow their respective settings and retention policies.

### Contact and changes

For privacy requests, including inquiries, access or deletion requests, and content reports, email [admin@datawake.cc](mailto:admin@datawake.cc). For general support, see the [Litch support page](ios-support.md). GitHub issues remain available for public feedback: do not post secrets, verification codes, personal files or full session transcripts. GitHub retains information you submit under its own policies.

We update this page when the policy changes and describe significant changes to data handling in app release notes.
