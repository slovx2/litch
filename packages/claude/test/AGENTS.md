# test/AGENTS.md

Tests run with the built-in `node:test` runner against compiled output. See the
[root AGENTS.md](../AGENTS.md) for project-wide conventions.

## Layout

- `*.test.mts` — sources compiled to `packages/claude/dist/claude/test/*.mjs`.
- `fixtures/` — shared test fixtures.

## Running

```bash
npm test            # builds, then runs node --test packages/claude/dist/claude/test/*.mjs
npm run build       # if you want to compile without running
node --test packages/claude/dist/claude/test/adapter.test.mjs   # a single suite, after a build
```

## Conventions

- Tests import from `dist/` (compiled `.mjs`), so **always build first** —
  `npm test` does this for you; editing a `.mts` and re-running raw
  `node --test` without a rebuild tests stale output.
- Use `CHA_CLAUDE_MOCK=1` to exercise protocol behavior without Claude
  credentials. Credentialed end-to-end checks live in `scripts/acceptance-*`,
  not here.
- Add new suites as `<area>.test.mts`; the `npm test` glob picks them up.
- 测试不继承个人环境。启动被测进程时用 `fixtures/isolated-env.mts` 的 `isolatedEnv` 作为基础环境，
  不要展开 `process.env`：本机的用户级 MCP 服务、模型凭据和代理会让结果随机器而变。
  `npm test` 另用 `--import` 预加载 `fixtures/isolate-process.mts`，测试进程自身的主目录也是空的临时目录；
  直接用 `node --test` 跑单个文件时没有这层预加载。
- Claude Code 的每用户临时根不看 `TMPDIR`，默认是 `/tmp/claude-<uid>`，本机所有 Claude Code 共用；
  后台命令的输出、贴进来的图、文件监视的探针都写在那下面。所以起 CLI 的环境都要带 `CLAUDE_CODE_TMPDIR`，
  指进用例自己的临时目录：`protocolEnv`、`isolatedEnv`、`isolate-process`、`daemon.mts`、`mcp-oauth.mts`
  都设成 `<主目录>/ct`，新增自己拼环境的夹具照做。这个路径超过 44 字节时，CLI 在沙箱里起的命令子进程
  `TMPDIR` 会退回 `/tmp/claude-<uid>`（CLI 自己会提示一句）；现有用例跑完那里没有多出东西。
- 等待被测进程输出必须有超时（`adapter.test.mts` 的读取器默认 60 秒），出问题要失败，不能无限挂起。
- 真实 CLI 用例只用 `CHA_CLAUDE_CLI` 指定的隔离 CLI，规则集中在 `fixtures/claude-cli.mts`。没设置时不跳过，
  也不改用 PATH 里的 `claude`：`ProtocolClient`（非 mock）和 `OAuthDaemonFixture` 立即抛错并说明原因；
  `isolatedEnv` 与 `isolate-process` 把它设成一个不存在的路径，被测进程和进程内解析 CLI 路径的用例会报“未找到”。
  新增会启动适配器的夹具时用 `requiredClaudeCli()` / `configuredClaudeCli()`，不要直接透传 `process.env.CHA_CLAUDE_CLI`。
- 会启动进程或监听端口的夹具要用 `fixtures/reclaim.mts` 的 `reclaimAtEnd` 登记收尾，`close()` 要能重复调用且有时限。
  用例超时或在进入 `try` 之前失败时自己的 `finally` 不会执行，留下的进程和端口会让测试文件一直不退出。
  `npm test` 另带 `--test-force-exit`：用例都结束后先执行上面登记的收尾，再退出进程，用例里自己建的
  监听端口不会再把文件挂住。直接用 `node --test` 跑单个文件时建议也带上（`test-harness.test.mts` 固定了这几种情形）。
- `MockLLM` 的应答按请求到达的顺序出队。同一个 CLI 进程里并发的两路请求（主会话与子代理）谁先到不固定，
  后台任务的结束通知是并进主会话正在准备的那次请求、还是另起一轮也不固定，慢机器上两种都会出现：
  应答要按请求内容路由；请求次数随先后变化的场景由用例把先后定下来（`native-subagents.test.mts` 的
  `enqueueFollowUp`：用模型应答的放行时机或钩子固定先后），不要按固定次数排队赌时序。
  一个回合用完自己的应答后先 `model.assertConsumed()` 再排下一回合的，剩下的应答不会被后面的请求吃掉。
- 要把“适配器正等在某一步”的先后定下来时，可以在被测进程的 `PATH` 最前面放一个可放行的假命令
  （`harness-declaration.test.mts` 的 DECL-005 里的 `gatedGit`），不要靠延时。
- 调试日志（`util.mts` 的 `debugLog`）不是记一行写一行：一轮事件循环里记的攒到这一轮末尾一次写，进程退出时也写。
  用例在同一个进程里记了日志又马上读文件的，先调 `flushDebugLog()`，或者等一轮（`setImmediate`）再读；
  读被测子进程的日志不受影响（它处理完一个请求、回过应答，那一轮早就写出去了）。
