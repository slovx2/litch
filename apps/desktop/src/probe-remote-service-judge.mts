// 远程设备第二遍验收的判定（量的办法在 probe-remote-service*.mts）。在主进程里跑，不进页面。
import type { ServiceAliases, ServiceConnect } from './probe-remote-service.mjs'
import type { FailureSeen, ServiceFailures, ServiceGrow } from './probe-remote-service-ends.mjs'
import type { ServiceSession } from './probe-remote-service-more.mjs'

export interface ServiceSeen {
  connect: ServiceConnect
  session: ServiceSession
  grow: ServiceGrow
  failures: ServiceFailures
}

/** 给人看的话里不该有 ssh 或 shell 的原话 */
const RAW = /Permission denied|command not found|No such file|ssh:|exit code/i

export function judgeRemoteService(seen: ServiceSeen, aliases: ServiceAliases): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const { connect, session, grow, failures } = seen

  // ---- 添加时的预览、连上之后是完整模式 ----
  must(connect.homeBlocked.includes('本机'), `新建对话页上没有说本机没连上：${connect.homeBlocked}`)
  must(
    connect.previewService.startsWith('service｜') &&
      /设备服务 \d+\.\d+\.\d+/.test(connect.previewService),
    `预览没有说出对面是设备服务和它的版本：${connect.previewService}`,
  )
  must(
    connect.previewServiceNote.includes('没在运行'),
    `设备服务还没起来的时候，预览没有照实说：${connect.previewServiceNote}`,
  )
  must(
    connect.previewCodex.startsWith('codex｜') &&
      /只有 Codex \d+\.\d+\.\d+/.test(connect.previewCodex),
    `预览没有说出对面只有 codex：${connect.previewCodex}`,
  )
  must(
    connect.previewCodexNote.includes('设备服务'),
    `只有 codex 的那台，预览里没有提装设备服务的事：${connect.previewCodexNote}`,
  )
  must(
    connect.notes.some((note) => note.includes('设备服务')),
    `连接途中没有说在启动设备服务：${JSON.stringify(connect.notes)}`,
  )
  must(
    connect.rowPeer === 'service' && /\d+ 个 harness/.test(connect.rowText),
    `设备列表上没有说对面是设备服务、有几个 harness：${connect.rowPeer}｜${connect.rowText}`,
  )
  must(connect.chips.includes('pi:on'), `设备列表上没有 Pi 的徽标：${connect.chips.join(' ')}`)
  must(
    connect.factPeer === 'service' && connect.facts.includes('设备服务') && !connect.codexHint,
    `详情里没有说对面是设备服务，或者还摆着“只有 codex”的提示：${connect.facts}`,
  )
  must(connect.manageReady, '管理页没有读到远程设备的管理数据')
  must(
    connect.harnesses.includes('pi:ready') && connect.harnesses.length >= 2,
    `管理页上没有列出那台机器上的 harness：${connect.harnesses.join(' ')}`,
  )
  must(connect.settings > 0, '管理页上没有读到远程设备的设置项')
  // 那台机器上的服务是这边经 ssh 执行 device-start 才拉起来的：按需拉起；应用不知道那边哪份算“自带的”，来源给路径
  const [serviceVersion = '', serviceOrigin = '', serviceDetached = ''] =
    connect.serviceFacts.split('｜')
  must(
    /^\d+\.\d+\.\d+/.test(serviceVersion) &&
      serviceOrigin.startsWith('path:/') &&
      serviceDetached === 'true',
    `详情里没有摆出那台机器上在跑的设备服务（版本｜来源｜是不是按需拉起的）：${connect.serviceFacts}`,
  )
  must(
    connect.growPeer === 'codex' && connect.growText.startsWith('只有'),
    `只有 codex 的那台，设备列表上没有照实说：${connect.growPeer}｜${connect.growText}`,
  )
  must(connect.workspaceAdded, `在远程设备上没能添加项目：${connect.workspaces.join('、')}`)
  must(connect.noPasswordField && failures.noPasswordField, '出现了密码输入框')

  // ---- 新建会话、发消息、断线、终端 ----
  must(session.target.length > 0, '新建对话页上换到远程设备之后，没有说会建在哪个 harness 上')
  must(session.stillBlocked === '', `换到连着的远程设备之后还说建不了：${session.stillBlocked}`)
  must(session.created, '在远程设备服务上新建会话没有收到回话')
  must(session.inWorkspace, '新会话没有落在选的项目里')
  must(
    session.badge === session.target,
    `新会话没有建在页上说的那个 harness 上：${session.target}｜${session.badge}`,
  )
  must(session.crumb.startsWith(`${aliases.svc}/`), `标题栏上不是那台远程设备：${session.crumb}`)
  must(session.dropped, '断掉 ssh 之后设备没有显示成没连着')
  must(session.recovered, '断线之后没有自己连回来')
  must(session.turnSurvived, '断线时正在进行的回合没有完整到达')
  must(session.sentAfter, '连回来之后发不了消息')
  must(session.terminalOpened && session.echoed, '在远程设备上开的终端里，命令没有结果')
  must(!session.ephemeral, '远程设备服务上的终端被标成了“随连接结束”')
  must(session.awayNote.length > 0, '断线的时候终端没有说它没连上')
  must(session.rejoined, '连回来之后终端还挂着没连上的说明')
  must(session.earlierKept, '终端接回来之后，断线之前的内容没了')
  must(session.replayedOnce, '断线前后那段输出没有正好出现一次')
  must(session.usable, '终端接回来之后不能接着用')

  // ---- 只有 codex 的提示、对面变了自己换过去 ----
  must(grow.factPeer === 'codex', `只有 codex 的那台，详情里没有照实说：${grow.factPeer}`)
  must(
    grow.hint.includes('设备服务') && grow.hintCommand.includes('install.sh'),
    `只有 codex 的那台，详情里没有提示和安装的办法：${grow.hint}｜${grow.hintCommand}`,
  )
  must(
    grow.rechecked.length >= 3 &&
      grow.rechecked[0]?.includes('ok') === true &&
      grow.rechecked.some((state) => !state.includes('ok')) &&
      grow.rechecked.at(-1)?.includes('ok') === true &&
      grow.stillCodex,
    `“重新检查”没有真的再连一次，或者对面没变却换了说法：${JSON.stringify(grow.rechecked)}`,
  )
  must(
    grow.switched && grow.switchedPeer.includes('设备服务') && grow.hintGone,
    `那台机器装上适配器之后，这边没有自己换成设备服务：${grow.switchedPeer}`,
  )
  must(grow.manageReady, '换成设备服务之后，管理页没有读到数据')
  must(grow.sessionsFollowed, '换成设备服务之后，侧栏里不是设备服务上的会话')
  must(grow.rowPeer === 'service', `换成设备服务之后，设备列表那一行没有跟着换：${grow.rowPeer}`)
  must(grow.othersBack, '同一份设备服务上的另一台设备断线之后没有连回来')

  // ---- 各种没连上 ----
  must(
    failures.previewRunning.startsWith('service｜') &&
      failures.previewRunningNote.includes('可用的 harness'),
    `设备服务在跑的时候，预览没有说出上面有哪些 harness：${failures.previewRunningNote}`,
  )
  const plain = (name: string, entry: FailureSeen) =>
    must(
      entry.text.length > 0 && !RAW.test(entry.text),
      `${name}：原因那句话是 ssh 或 shell 的原话，或者是空的：${entry.text}`,
    )
  const { legacy, down, old } = failures
  plain('旧服务在跑', legacy)
  must(
    legacy.stage === 'outdated' &&
      legacy.text.includes('旧版') &&
      legacy.guides.includes('devices.guide.restartService') &&
      legacy.commands.some((command) => command.includes('restart')),
    `旧服务在跑的那台，没有停在对应的阶段上，或者没有说该怎么办：${JSON.stringify(legacy)}`,
  )
  must(legacy.pill.includes('err'), `旧服务在跑的那台不该自己一直重试：${legacy.pill}`)
  plain('设备服务起不来', down)
  must(
    down.stage === 'startFailed' && down.text.includes('没能起来') && down.detail.length > 0,
    `设备服务起不来的那台，没有停在对应的阶段上，或者没有带上对面的原话：${JSON.stringify(down)}`,
  )
  must(!down.pill.includes('err'), `设备服务起不来的那台该是隔一阵再试：${down.pill}`)
  plain('适配器太旧', old)
  must(
    old.preview.includes('版本太低') &&
      old.stage === 'outdated' &&
      old.text.includes('太旧') &&
      old.guides.includes('devices.guide.upgradeService') &&
      old.commands.some((command) => command.includes('install.sh')),
    `适配器太旧的那台，没有停在对应的阶段上，或者没有说该怎么办：${JSON.stringify(old)}`,
  )
  must(old.pill.includes('err'), `适配器太旧的那台不该自己一直重试：${old.pill}`)
  must(
    failures.homeGuides.includes('devices.guide.upgradeService') &&
      failures.homeCommands.some((command) => command.includes('install.sh')),
    `新建对话页上选到适配器太旧的那台，没有当场说该怎么办：${failures.homeGuides.join(' ')}`,
  )
  return failed
}
