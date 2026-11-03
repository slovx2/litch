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

这个入口不在 `client:test`、Full 或 nightly 的必跑集合中。macOS 上已观察到原生
`fs.watch` 在部分变更后没有回调，去掉 Litch 的监听封装仍可复现；根因尚未确认。
因此它用于人工调查原生事件交付，不能作为稳定的发版门禁。

不依赖原生事件的逻辑回归继续由 `test/files-refresh.test.mts`、`test/file-trees.test.mts`
和 `test/files.test.mts` 执行。下一版从本诊断入口跟进监听可靠性，评估可见面板低频核对、
重新获得焦点时补读，以及打开文件的元数据监视；方案确定前不增加产品轮询。
