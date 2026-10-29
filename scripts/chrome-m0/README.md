# Chrome M0 隔离探针

验证 Chrome 扩展、Native Messaging、debugger、页面坐标和生命周期的真实平台行为。**不是产品实现，不注册 Litch 工具，不得把这里的任意 CDP/evaluate 调试接口交给模型。** 弹窗的 DNR 和 MAIN-world 改写仅是对照实验，不进入产品。

需要 Node 24 和已安装的 Chrome for Testing，显式提供浏览器可执行文件路径。没有新依赖，不自动下载浏览器。

```sh
CHROME_M0_BINARY='/absolute/path/to/Google Chrome for Testing' node scripts/chrome-m0/run.mjs
CHROME_M0_BINARY='/absolute/path/to/Google Chrome for Testing' node scripts/chrome-m0/run.mjs --lifecycle-only
CHROME_M0_BINARY='/absolute/path/to/Google Chrome for Testing' node scripts/chrome-m0/run.mjs --popup-only
```

默认 headless。只有已获得前台验收时段才允许传 `--shown`；人工输入/真正 DevTools 前台行为仍须另验，headless 结果不能代替。

## 隔离

- 临时 HOME、CODEX_HOME、Chrome profile、扩展和 Native Messaging 清单；不读取日用配置、Cookie/密码库或 SSH 配置。
- 固定 `--use-mock-keychain --password-store=basic`，只作用于探针 Chrome。不要给产品的用户 Chrome 加这些参数。
- 调试端口先向 OS 申请空闲端口，再确认监听 PID 等于本次子进程；禁用 9333。CDP 仅用于测试器观察这个隔离浏览器，产品通道是扩展 debugger。
- 网页和 Cookie 全是回环 HTTP 夹具，a.test/b.test 映射到回环。没有真实账号或外站业务动作。
- 完成时停止本次 Chrome/桥，临时证据保留并打印路径；不会自动删除目录。正式结果需要移到工作区再归档。
- 指针的版本和坐标契约直接引用 `packages/protocol/src/automation-surface.mts`。紫色 `M0` 圆只是验证页面承载与截图排除的临时标记，正式光标动画由公共渲染器提供。

## 文件

| 文件 | 职责 |
|---|---|
| run.mjs / cdp.mjs | 构建临时扩展、拉起隔离浏览器、验证端口归属、驱动及收尾 |
| native-host.mjs | 仅此探针的 stdio 原生消息与 Unix socket 转发 |
| extension.mts | 最小权限 API 探测、公共指针类型、临时租约与 worker 恢复清理 |
| fixtures.mjs | HTTP 页面、登录 Cookie、跨源 iframe/弹窗与请求计数 |
| probes.mjs | 页面能力、截图/AX 排除、坐标、导航及释放 |
| lifecycle-probes.mjs | 内部 URL、DevTools、worker 停止/唤醒、桥断开 |
| popup-extension.mts / popup-probes.mjs | 四种触发方式与八个拦截对照、普通用户标签误伤检查 |

## 怎么读结果

`results.json` 保存 Chrome 版本、PID/端口核验、各探针结果和夹具请求记录。基础探针另存 baseline/marker/hidden 三张 PNG。

`PASS` 只表示该探针按设计完成记录或断言，**不代表记录的限制消失**：

- DevTools 探针的 `detached:false` 表示本轮没有观察到自动撤销。
- 弹窗探针的 `firstRequestSent:true` 表示目标服务端收到了请求；`unleasedSameOriginBlocked:true` 表示规则误伤了普通用户标签。
- worker 重新启动会换 epoch、撤之前登记的调试器；不会恢复旧租约。单纯全局变量清空不够。
- 来源审批的产品边界应是“未批准来源不能被代理读取、截图、操作或认领”。不承诺网页不能自行跨源发请求；本探针没有实现完整产品审批层。

当前脚本只验证本机 macOS Chrome for Testing。远程会话经 Litch 操作控制端 Chrome 的 M2、正式 UI/审批、稳定版 Chrome、人工接管与其他 OS 都不在这里冒称已验。
