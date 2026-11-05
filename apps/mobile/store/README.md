# iOS 商店材料与发布

正式包 `dev.litch.app`。商店名称 `Litch — Remote Workspace`，安装后的名称仍为 `Litch`。
商店名称在 App Store Connect 创建记录时校验；不要用公开搜索判断是否可占用。
中英文草稿见 [metadata.md](metadata.md)。发布前须审阅实际地区、隐私问卷、年龄分级和审核备注，上传 TestFlight 不等于提交 App Store 审核。

## 构建与凭据

Release 工作流的 `ios-testflight` 默认关闭；开启时另填递增的 `ios-build-number`，例如 `1.0.1`。
它等待同一 SHA 的正式候选封存成功，禁止 `bypass-gate`，在固定 Xcode 的 macOS runner
上 archive、export、检查最终 IPA 的签名、团队、版本、Keychain entitlement、分发描述文件和隐私资源，
然后上传这同一份 IPA。iOS 不属于 GitHub Release 的五类公开资产，也不会随其晋级重新构建。
上传成功仍需 App Store Connect 处理、出口合规、内部测试组和真机验收。

仓库变量：`IOS_TEAM_ID`。专用团队 App Store Connect key 的 GitHub secrets：

- `IOS_ASC_PRIVATE_KEY`：原始 `.p8` 内容，通过 stdin 重定向从文件读取，禁止回显。
- `IOS_ASC_KEY_ID`、`IOS_ASC_ISSUER_ID`：对应标识，App Manager 角色只负责上传。
- `IOS_DISTRIBUTION_P12`：专用 Apple Distribution 身份的加密 PKCS#12，以 base64 写入。
- `IOS_DISTRIBUTION_PASSWORD`：随机 PKCS#12 密码。
- `IOS_APP_STORE_PROFILE`：只绑定正式包和该证书的 App Store Connect 描述文件，以 base64 写入。

用 `gh secret set IOS_ASC_PRIVATE_KEY --repo slovx2/litch < /绝对路径/AuthKey_标识.p8` 导入；
下载后立即导入安全存储，不放仓库。确需本机留备份时由账号持有人明确指定保存位置，
否则删除临时下载文件；CI 的临时副本始终清理。证书私钥只在钥匙串中生成/保存。
CI 将专用分发身份导入独立临时钥匙串，使用手动签名；不会请求云端签名权限。
API key、加密 p12 与描述文件只存在当前进程的私有临时目录，退出清理；恢复原钥匙串列表。
`ios-signing-identity.swift` 可在本机钥匙串生成 CSR，再导出加密 p12；密码由 stdin 提供，临时 p12 写入 secrets 后删除。
不得为了首次签名重试而撤销团队已有证书。

本地备用路径：先安装根目录、`packages/ui`、`apps/mobile` 的锁定 npm 依赖和 CocoaPods 1.16.2，
先把专用分发身份装进本机钥匙串；设置 `LITCH_IOS_TEAM_ID`、`LITCH_IOS_BUILD_NUMBER`
和外部描述文件绝对路径 `LITCH_IOS_PROFILE_PATH`，
运行 `node apps/mobile/scripts/archive-ios.mjs`。脚本默认只导出，不上传。
输出在 `apps/mobile/.release-ios`（应被 git 忽略），用 Xcode Organizer / Transporter 手动上传经校验的包。
用 `altool` 上传时单独提供 API Key ID、Issuer ID 和 `API_PRIVATE_KEYS_DIR`。签名不要求 Xcode 登录。
密钥不能位于仓库内，不要将签名日志、archive、描述文件作为公开 Release 资产。

`ITSAppUsesNonExemptEncryption` 未设为固定 false。先按实际依赖和地区完成加密分类与问卷；
如 Apple 要求材料或授权码，补齐后再处理，不把缺失合规提示视为上传失败而重复打包。

## 截图

按 [Apple 截图规格](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
使用 iPhone 6.9 英寸槽支持的原始模拟器尺寸，例如 1320×2868，PNG，不拉伸界面。
中英文分别展示真实会话、设备列表、终端和审批/文件体验；只用隔离演示数据。
开发包与正式包共用界面，但不能把夹具标记、调试信息或不提供给用户的功能截入正式材料。
应用未声明 iPad 支持，不以模拟 iPad 截图代替 iPhone。

## 审核演示方案

推荐隔离公网演示主机：真实 SSH、设备服务、测试仓库、独立低权限账号，整个审核期间在线。
单独限制网络出口、资源和模型费用；不给审核员个人电脑、生产环境、真实项目或个人模型凭据。
审核备注提供稳定连接步骤、主机指纹及必要的专用凭据，失效后轮换。配对码有时限，不能把一次性过期二维码当作唯一入口。

内置模拟模式无需持续主机成本，适合预览，但难证明真实 SSH、Tailscale、权限与文件链路，
且不完整模拟不能满足全功能审核。当前开发者“模拟核心”不是已获 Apple 认可的审核演示模式。
若用它替代演示账户，先说明原因并获得 Apple 认可；不能隐藏网络能力或临时改变审核行为。
第三方案是审核视频加文档，只可辅助，不能替代可操作的 App。

支持 URL 可以是公开 GitHub 页面并链接 issues；隐私 URL 必须是完整可访问政策。
不要将注册组织所需的公司官网域名要求与 App 的支持 URL 混为一谈。
公开 issues 不适合收取私人材料，应准备专用支持/隐私邮箱。
