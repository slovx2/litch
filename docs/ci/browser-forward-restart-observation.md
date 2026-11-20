# 用户标签转发用例的偶发失败观察

## 已确认的事实

- CI push：run `44751256716`、attempt 1，`browser / checks`，
  [job 136339617707](https://github.com/slovx2/litch/actions/runs/44751256716/job/136339617707)。
- 实际 checkout：`0e6e66bb044310592ac5fa8a899a0c4952bdf626`。
- 失败用例：`apps/desktop/src/browser/test/remote-local.test.mts` 的
  “远程借用本机用户标签按控制者改写 localhost；交还后的标签仍保活原隧道”。
- 错误：`fetch failed`，原因 `ECONNREFUSED 127.0.0.1:49280`。
  浏览器主测试 196 项中只有这一项失败，随后导入读取器测试没有失败。
- 同 SHA、源码未改时，本地执行 `npm run test:browser --prefix apps/desktop` 退出码 0；
  主测试 196/196 通过（包含该用例），读取器 32 项通过、1 项按原条件跳过。
- 本地环境：macOS arm64，Node 24.19.0；结果于 `2026-11-20T14:28:56Z` 核实。
  日志 SHA-256：`84a870ff1a298773277f676a3fda6e30454f0b14e6a2d1d508d8cb769945f72b`。
- 用相同 esbuild 配置检查该测试的打包图，共 35 个输入；与 C 线相对基线新增或修改的
  19 个文件交集为空。浏览器实现、测试、构建脚本和依赖锁文件均未被 C 修改。
- 只向该失败 job 发起补跑，没有重跑整个工作流，也没有运行 Full。

## 可能的原因，尚未确证

假 SSH 在监听前写入 PID 文件。此用例重建后只等待 PID 变化且进程存活，随即 fetch，
没有等待端口监听。相比之下，产品转发器会等待 TCP 连通才把 running 置为 true。
这是一处可能产生连接拒绝的测试时序窗口。

CI 没有留下第二次 fetch 的阶段及监听事件时间，不能把这一窗口写成本次失败的已证根因。
同 SHA 未改代码复跑通过足以按账本规则确认偶发；没有发现 C 引入回归的证据。
