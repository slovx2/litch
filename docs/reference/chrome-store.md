# Chrome Web Store 自动提交

扩展条目固定为 `ddnllmibgnhhiiaaidfamlknbnfjpnpo`。`promote.yml` 的 `chrome-store` 作业只在桌面 `publish` 作业成功后运行：确认公开 Release 和候选 SHA，比较商店当前公开版本的交付摘要，有变化才上传并送审，审核通过后由 Google 自动公开。`verify`、`draft` 和普通 CI 不访问商店。

## 一次性设置（由发布者本人完成）

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立或选择项目，启用 **Chrome Web Store API**。
2. 在 IAM & Admin → Service Accounts 创建专用服务账号；无需授予项目 IAM 角色。在 Keys → Add key → Create new key 下载 JSON 密钥。
3. 登录 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole)，切到拥有该条目的发布者。在 **Account** 的服务账号设置中加入上一步的服务账号邮箱；在 **Publisher → Settings** 复制 **Publisher ID**。这是发布者 ID，不是展示名称或扩展 ID。
4. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Repository secrets** 添加：
   - `CWS_SERVICE_ACCOUNT_JSON`：完整的服务账号 JSON。
   - `CWS_PUBLISHER_ID`：上一步的 Publisher ID。
5. 后续照常授权并执行桌面 `promote.yml` 的 `publish`。查看独立 `chrome-store` 作业及 Summary；“已提交审核”不等于已经上架。首次配置后需实际验收一次审核和公开结果。

登录、授权、下载私钥及添加 GitHub Secrets 均由用户本人操作，不把密钥交给代理、写入仓库或贴进日志。自动化只读取这两个仓库机密；JWT 和访问令牌只驻留内存。构建步骤不接收商店机密，调用 `gh` 时也移除它们。不使用个人 OAuth refresh token。缺任一机密时，不构建商店包、不请求 Google，安静跳过并在 Summary 提醒手动处理。

官方依据：[服务账号配置](https://developer.chrome.com/docs/webstore/service-accounts)、[服务账号 JWT 换取访问令牌](https://developers.google.com/identity/protocols/oauth2/service-account#httprest)。若组织策略禁止创建服务账号密钥，需要管理员处理；当前实现不自动切换认证方式。

## 比较和留存

`scripts/ci/chrome-store-package.mjs` 调用候选 SHA 内的 `apps/desktop/scripts/build-chrome.mjs`，依赖使用该提交的桌面 lockfile。产物移除 manifest 的 `key` 与 `identity.json`，生成完整 ZIP 和 `chrome-store-package.json`。

内容摘要对每个交付文件的路径及字节计算 SHA-256；仅对 manifest 规范化 JSON 并排除 `version`。ZIP 时间戳、压缩方式、条目顺序不参与比较。运行时代码（包括打入的共享代码）、资源、权限和最低 Chrome 版本的变化都会计入。没有依赖目录 diff 或上次桌面版本推断是否需要上传。

API 的 `fetchStatus` 提供当前公开版本，不提供包下载或内容摘要。比较基准按该版本查找同名 GitHub Release 的 `chrome-store-package.json`，并验证 GitHub 提供的资产 SHA-256；手工历史基准登记在 `scripts/ci/chrome-store-baselines.json`。首次基准为发布者实际上传的 0.36.0 ZIP，不将“正在审核”当成已公开；只有 API 返回它已公开后才采用。

有变化时，先在配套的**已公开** GitHub Release 添加商店 ZIP 和摘要、回验资产摘要，再上传商店。留存记录意味着“已准备向商店上传”，不证明商店已收到或审核通过；是否公开始终查询商店状态。后续手工提交必须保存实际上传 ZIP，并登记其摘要，否则自动化停止，不能拿另一个版本作基准。

自动化假设这个条目同一版本没有被人工替换成另一份 ZIP；API 无法证明后台草稿的字节。不要在商店作业运行时手动上传包。商店文案、隐私声明、权限理由、测试说明和 Distribution 仍在后台维护；可见性变化可能需要先手工发布一次。

## 异常和恢复

- 已有待审或待发布版本：跳过，不取消、不替换，也不把人工选择的延后发布改成自动公开。等待该提交结束后，可单独重跑原工作流的 `chrome-store` job；不要重跑已经完成公开的 `promote` job。人工延后版本仍在后台点 Publish。
- 拒审、取消、政策提示、非全量公开、缺少基准或版本倒退：失败并写 Summary，转人工处理；不自动忽略审核问题。
- 上传异步处理：最多轮询约一分钟，确认成功后才送审。写请求失败/超时不盲重试；Google 可能已收到请求。核对后台包版本和审核状态后再处理。
- 已存在本版商店 ZIP/摘要但没有待审版本：停止，避免含糊失败后重复上传。若后台已有该 ZIP，可手动 Submit for review，并在桌面已公开的前提下勾选自动发布；若确认根本没有上传，可由维护者核对并清理本版这两个资产后单独重跑商店 job。脚本不会自己删资产。
- 商店 job 失败不撤回已经公开的桌面 Release。`promotion` 资产仍是桌面原始证明；新增商店资产不属于桌面候选封存清单。仅允许这一独立作业在公开后构建商店 ZIP，桌面晋级仍不重构建、重签或重公证。

手动方式：从对应发版提交运行 `CANDIDATE_SHA=<完整SHA> node scripts/ci/chrome-store-package.mjs <源码目录> <全新输出目录>`（Node 24；先在源码的 `apps/desktop` 执行 `npm ci --ignore-scripts`）。上传输出的完整 ZIP 至现有条目，维护必要资料后提交；提前送审时关闭自动公开，等配套桌面端公开再发布。

## API 事实与验收边界

| 操作 | 官方支持与链接 |
|---|---|
| 上传 | `POST /upload/v2/publishers/{publisherId}/items/{itemId}:upload`；可返回异步处理中，需轮询。[upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload) |
| 查状态 | `GET /v2/publishers/{publisherId}/items/{itemId}:fetchStatus`；区分已公开与已提交版本，含版本号和上传处理状态。[fetchStatus](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus) |
| 送审并自动发布 | `POST …:publish`，`publishType: DEFAULT_PUBLISH`，`skipReview: false`；通过审核后自动公开。[publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish) |
| 延后发布 | 同一 publish 方法用 `STAGED_PUBLISH` 送审；通过后再次调用 publish 可公开。本实现不采用它。[publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish) |
| 认证 | V2 支持服务账号；也支持用户 OAuth 客户端及 refresh token。当前只选服务账号 JWT，scope 为 `https://www.googleapis.com/auth/chromewebstore`。[服务账号](https://developer.chrome.com/docs/webstore/service-accounts)、[OAuth 教程](https://developer.chrome.com/docs/webstore/using-api) |

以上为官方文档确认的事实。单元替身验证的是请求、状态控制、摘要和无凭据跳过，不能证明该发布者已授权成功、Google 会批准或批准所需时间；这些在首次真实运行前均未验证。手工登记来源的真实性由上传记录保证，API 不返回包摘要，不能独立核实。

本地检查：`node --test scripts/ci/chrome-store-*.test.mjs`。这些测试不读取个人凭据，也不连接真实商店。
