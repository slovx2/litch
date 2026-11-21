# GitHub 无人值守：设备接线和验收

设备进程在适配器取得状态目录锁后启动 GitHub 采集、收件箱、投递及回写。配置、经理工具和后台调度共用经理库。直接连接本机设备套接字可执行管理员操作；`device-proxy` 连接独立的只读外部来源入口，客户端声明扩展不能提升访问权限。自启 RPC 只有在接受应答交给连接后才释放系统助手执行变更。

设备从已核验可读身份中选择仓库采集凭据；指定采集身份时不会换用其他身份。提醒只在引擎发送点登记，回写用独立持久队列。发送结果不明时按原线程、组标识和引擎历史对账；计划重启不把外部提醒当作用户输入恢复。工作线在启动 `gh` 或 Git 时按实际经理归属取得本次启动的环境，程序使用的采集凭据不进入启动环境。来源暂停或撤销后，助手重新查证，不再交付该范围的机器人凭据。

发布包不带 GitHub CLI。设备需要受管 gh 时才取 GitHub 官方 2.102.0 归档，使用代码中固定的各平台 SHA-256 校验，只提取二进制和许可证。原子安装到设备私有状态目录后，再运行 `--version` 核对。下载遵守代理设置，重试有上限。清理旧版需要上一设备进程在退出时确认没有使用者。导入系统 gh 登录和粘贴令牌不会触发下载。

## 验收入口

- `npm run build --prefix packages/device && npm run check:external-github`：回环 GitHub、假 gh、假引擎、实际设备库和双 WebSocket。核对授权、来源预览、权限拦截、及时反馈和查证、接单、工作线 gh、PR 显式关联、动作运行提醒、断线及计划重启。CI 快门禁调用同一入口。
- `node --import tsx --test packages/device/test/github-cli-install.test.mts packages/device/test/external-gh-authorization.test.mts`：回环下载、代理、并发、两种归档、错误哈希、旧版本清理、授权失败后粘贴令牌及系统导入。
- `node scripts/build-cli.mjs && node --test scripts/check-external-github-device.mjs`：macOS/Linux 真实设备生命周期、只读代理、自启状态、回环 GitHub 与重连；启动临时状态目录，不安装系统自启登记。
