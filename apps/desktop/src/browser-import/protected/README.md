# 浏览器受保护数据读取器

入口是 `index.mts` 的 `createProtectedReader()`，在 Electron 主进程调用。只返回本次选中的类别，不写目标浏览器、不经 IPC 发送明文、不记录日志、不联网。没有新增运行时依赖。

## 实现与支持边界

| 来源 / 格式 | 行为 |
| --- | --- |
| macOS Chrome、Edge、Brave、Arc、Chromium、Vivaldi | 用 `/usr/bin/security` 查询该来源的 Safe Storage；系统决定是否弹授权。支持 v10 AES-CBC，校验 Cookie 库 v24 起的主机摘要。 |
| Windows 上述 Chromium 来源 | 支持当前用户 DPAPI、Local State 密钥以及 v10/v11 AES-GCM；不跨用户、不自行提权。 |
| Windows v20 应用绑定记录 | `allowElevated=false` 返回 `needs-elevation`；为 true 时返回 `unsupported`。本模块没有应用绑定解密助手。该边界需主线在产品范围里明确，不能把勾选同意写成“保证能读”。 |
| Firefox（Mac / Windows） | 读取 cookies.sqlite、logins.json、key4.db；支持无主密码的资料、NSS PBES2/AES-CBC 密钥、密钥属性签名、3DES/AES 登录记录。 |
| Firefox 主密码、key3.db、未知算法 | `unsupported`。接口不增加主密码参数，不尝试破解。Cookie 可单独成功。 |
| Firefox 容器 / 私密 / 无法表达的分区 | 该条记为读取失败，不混入普通浏览会话；可表示的 partitionKey 返回顶层站点。 |
| 其他平台或未知来源 | 能力为空，选中类别返回 `unsupported`。 |

每次调用才取系统密钥；一次调用内共享，调用结束擦除 Buffer 并释放引用。字符串受 JavaScript GC 管理，不能承诺物理内存即时清零。产品需要在用户点导入之后才调用 `read`。`capabilities` 不读资料、不弹授权。

Windows Chromium 的 `needsElevation` 是保守提示：接口不接收资料路径，无法事先知道某一份资料里是否混有 v20。普通记录仍可独立读出，混合资料返回 `partial`。`promptsSystemAuth` 只在 macOS Chromium 为 true。

## 文件与错误处理

- 来源文件及所有祖先都检查符号链接；最终文件以 O_NOFOLLOW（平台提供时）和只读模式打开，核对文件身份。不接受目录、设备等非普通文件。
- 数据库及存在的 `-wal`、`-journal`、`-shm` 一起拷到系统临时目录中的随机私有目录。POSIX 为 0700/0600；Windows 复制前用当前用户专属 DACL 限制目录。不会尝试复制独占文件或启动管理员进程。
- 复制前后核对 inode、大小、修改时间、变化时间及旁路文件集合；来源变化报 `locked`。这是文件快照检查，不是操作系统级原子快照；界面仍需要求完全关闭来源浏览器。
- 仅在副本上打开只读 SQLite 连接，并启用 query_only、trusted_schema=OFF、temp_store=MEMORY。用完关闭连接，再删除私有目录。失败和取消也走清理。
- “不落明文”指不持久化解密产物；Firefox Cookie、Chromium 的少量明文 Cookie 本来就在来源文件中，按接口要求复制的数据库仍可能包含这些原始值，故必须有私有权限并及时删除。
- 每个来源文件上限 512 MiB；DER 限深、PBKDF2 上限一百万次；系统子进程有输出限额和超时，取消后结束，必要时强制结束。不创建常驻助手。
- 外部错误、SQLite 错误、子进程 stderr 都不作为返回文案。对外只有固定的英文错误说明。
- `discovered` 是成功打开的来源库中的总条数，包含域名筛选排除的条目；筛选掉的记录不解密、不计 failed。`failed` 只计能够确认的失败记录。某一整个库打不开时无法知道条数，不编造数字；另一库读成功时可能出现 `partial` 且 `failed=0`，用 error 表明存在库级失败。这是接口计数语义的边界，管线不能只看 failed 判断成功。
- Cookie 时间、失效记录和非网页密码来源交管线判无效。Chromium 本地库和账号库均读，store 分开。Firefox 的会话 Cookie 不在 cookies.sqlite 中，本模块不额外读 sessionstore。

## 对接与交接

本目录独占；没有修改管线、界面、全局脚本或依赖清单。`types.mts` 是临时接口副本。管线合并后：

1. 以本目录 `index.mts` 替换管线的空桩。
2. 将内部契约类型改从 `../protected-types.mjs` 引用；`BrowserId` 单独从 `../types.mjs` 引用。测试目录的相对路径多一层。
3. 删除本目录 `types.mts`，跑下面的单测和桌面端类型检查。没有改变约定接口。
4. 主线把 `test/run.mjs` 纳入全量检查；管线与界面测试仍用假读取器。
5. 用新建的 Chrome / Firefox 测试资料做真实窗口导入验收，逐类核对写入结果。Windows 上补真实 DPAPI、非 ASCII 临时路径、目录 DACL 和独占文件检查。

目前【事实】：自造库单测、NSS 生成的隔离资料、Node 24.21.0、Electron 44.7.0 中的测试，以及桌面端类型检查和构建已经验证。【未验证】：七家来源逐一的真实系统授权、Windows 原生运行、管线写入后的登录态。测试没有读取日常浏览器资料或钥匙串。

## 测试

从仓库根运行，要求 Node 24；本目录测试用 esbuild 打包到临时目录，结束即清理：

```sh
node apps/desktop/src/browser-import/protected/test/run.mjs
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
```

默认测试全部使用自造库和假的系统密钥。另有一个默认跳过的交叉验证：用本机 NSS 在新的空目录生成真实格式的 key4.db 和加密登录记录；只需要测试机上的 uv/Python/NSS，产品运行不需要它们。已分别对 NSS 3.106 的 3DES、Firefox 所带 NSS 3.118 的 AES 验证通过。

```sh
# 独立 NSS（库路径按测试机指定）
LITCH_TEST_NSS_LIBRARY=/opt/homebrew/lib/libnss3.dylib \
  node apps/desktop/src/browser-import/protected/test/run.mjs

# Firefox 新版 NSS 的 AES 测试；只加载库，不启动浏览器、不打开现有资料
DYLD_LIBRARY_PATH=/Applications/Firefox.app/Contents/MacOS \
LITCH_TEST_NSS_LIBRARY=/Applications/Firefox.app/Contents/MacOS/libnss3.dylib \
LITCH_TEST_NSS_AES=1 \
  node apps/desktop/src/browser-import/protected/test/run.mjs
```

实现依据是公开格式与系统 API，未复制其他产品的实现：

- [Chromium Cookie 库版本与域名摘要](https://chromium.googlesource.com/codesearch/chromium/src/+/refs/tags/141.0.7390.17/net/extras/sqlite/sqlite_persistent_cookie_store.cc)
- [Mozilla NSS 密钥数据库与属性签名](https://github.com/nss-dev/nss/blob/master/lib/softoken/sftkpwd.c)
- [Mozilla NSS 的密码派生参数](https://github.com/nss-dev/nss/blob/master/lib/softoken/lowpbe.c)
- [Mozilla NSS 的登录记录封装](https://github.com/nss-dev/nss/blob/master/lib/pk11wrap/pk11sdr.c)
