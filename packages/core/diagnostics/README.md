# 文件监视的真实磁盘诊断

在仓库根目录使用 Node 24 并安装根依赖后运行：

```sh
npm run client:diagnose:files-refresh
```

macOS 可用低优先级复查：

```sh
taskpolicy -b npm run client:diagnose:files-refresh
```

诊断在临时目录里验证修改、原子替换、重命名、删除和重建，退出时关闭监视并清理目录。
所有功能断言与超时保留；失败仍返回非零状态，不重试被测操作。

这个入口不在 `client:test`、Full 或 nightly 的必跑集合中。此前“未收到事件”的判断只覆盖
用例等待窗口，不能区分丢失和迟到。分层检查须同时记录系统 FSEvents 回调、libuv/Node
回调及事件循环心跳的单调时钟，不能仅凭另一进程收齐了通知就认定 libuv 丢失。

可主动丢弃所有原生通知，验证真实磁盘的改名、删除、原子替换仍由对账刷新：

```sh
LITCH_DIAG_DROP_FILE_EVENTS=1 taskpolicy -b npm run client:diagnose:files-refresh
node --import tsx packages/core/diagnostics/files-reconcile-bench.mts
```

对账间隔为上一轮完成后 5 秒，随后有 250ms 通知合并和实际读取时间；后台进程暂停、
操作系统调度及网络延迟不受该间隔约束，不能保证墙钟时间内必达。诊断每步等待预算为
20 秒、整例为 120 秒，不重试操作，输出每步刷新延迟、stat 与内容读取次数。
性能脚本使用 3 万条目的真实目录和 1000 个可见目录，输出无变化时的请求量、CPU 与事件循环延迟。

不依赖原生事件的逻辑回归由 `test/file-reconcile.test.mts`、`test/files-refresh.test.mts`、
`test/file-trees.test.mts` 和 `test/files.test.mts` 执行。
