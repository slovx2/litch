// 设备与 harness 管理的验收：量到的东西里哪些算不合格。
// 量的办法在 probe-manage-mock.mts（对着模拟核心）和 probe-manage.mts（对着真的设备服务）；
// 这里的函数在主进程里跑，不送进页面。
import type { ManageProbe } from './probe-manage.mjs'
import type { MockManageProbe } from './probe-manage-mock.mjs'

export function judgeMockManage(probe: MockManageProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const same = (actual: unknown, expected: unknown, what: string) =>
    must(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`,
    )

  same(
    probe.entries,
    ['local:1:0', 'build:1:0', 'nas:1:0', 'gpu:1:0'],
    '设备列表上的一行不是“整行一个按钮、没有别的控件”（标识:按钮数:输入控件数）',
  )
  same(
    probe.deviceActs,
    [
      // 只有 codex 的那台多一个“重新检查”：装上设备服务之后点它，重新连一次就换过去
      'nas:rename+edit+remove+recheck',
      'gpu:reconnect+rename+edit+remove',
      'local:',
      'build:rename+edit+remove',
    ],
    '详情里“这台设备”一节能做的事不对',
  )
  must(
    probe.plainState === 'unsupported' && probe.plainShell === 0 && probe.plainFacts >= 3,
    `没有设置接口的设备，详情页不是“只有连接信息”：${probe.plainState}，管理区的东西 ${probe.plainShell} 个，连接信息 ${probe.plainFacts} 行`,
  )
  must(
    probe.offlineState === 'offline' && probe.offlineShell === 0,
    `没连上的设备，详情页不对：${probe.offlineState}，管理区的东西 ${probe.offlineShell} 个`,
  )
  const [offlineText = '', offlineSaid = ''] = probe.offlineWhy.split('｜')
  must(
    offlineText.length > 0 && offlineSaid.includes('gpu-box'),
    `没连上的设备，详情里没有原因和对面的原话：${probe.offlineWhy}`,
  )
  must(
    probe.foldedShown === '0/0/0/0/0',
    `详情一打开就露出了该收着的东西（设置项/原因/环境文件里的变量/入口的状况/配置片段的按钮）：${probe.foldedShown}`,
  )
  // codex 那一组里启用项排在第二（模拟核心的样例故意这样摆）：标题行上照样有开关，认的是角色标记
  same(
    probe.heads,
    [
      'claude:false:true:有重启',
      'pi:false:true:有重启',
      'dsh:false:true:有重启',
      'codex:false:true:有重启',
    ],
    '收着的时候 harness 的标题行不对（标识:开没开着:标题行上的开关:重启）',
  )
  same(
    probe.summaries,
    ['状况：1 个没起来，1 个在监听', 'ssh：开着 2 个', 'terminal：', '环境文件：2 个变量'],
    '收着的各节，标题后面的摘要不对',
  )
  must(probe.foldsReachable, '收起展开的地方不都是聚焦得到、带着状态和箭头的按钮')
  must(
    probe.foldToggles === 'true:true:true>false:false',
    `点开再收起不对（开着:按钮的状态:内容在不在 > 收起之后）：${probe.foldToggles}`,
  )
  same(
    probe.harnesses,
    ['claude:ready', 'pi:ready', 'dsh:ready', 'codex:unavailable'],
    '本机的 harness 和状态不对',
  )
  must(probe.downReason.length > 0, '不可用的 harness 没有写原因')
  same(
    Object.entries(probe.controls)
      .map(([type, control]) => `${type}=${control}`)
      .sort(),
    [
      'boolean=switch',
      'enum=select',
      'env=env',
      'integer=number',
      'path=text',
      'schedule=readonly',
      'secret=password',
      'string=text',
    ],
    '各种类型的设置没有画成对应的控件',
  )
  must(
    probe.unknownNote.includes('schedule') && !probe.unknownEditable,
    `不认识的类型没有只读地摆出来并说明：${probe.unknownNote}`,
  )
  must(probe.secretShown === '已设置', `已保存的密钥没有显示成“已设置”：${probe.secretShown}`)
  must(
    probe.envSecretShown === '已设置' && !probe.envSecretHasInput,
    `环境变量表里已保存的密钥没有显示成“已设置”：${probe.envSecretShown}`,
  )
  must(probe.inheritedSecret === '已设置', `环境文件里的密钥露出来了：${probe.inheritedSecret}`)
  same(
    probe.sshStates,
    ['claude:listening', 'pi:failed', 'dsh:off', 'codex:off'],
    'SSH 入口的状况不对',
  )
  must(
    probe.sshFailedReason.includes('22231'),
    `入口没起来的原因没有显示：${probe.sshFailedReason}`,
  )
  must(
    probe.english.startsWith('CLI path'),
    `切到英文，设备服务给的标题没有跟着换：${probe.english}`,
  )

  must(
    probe.leadOpens === 'true:false:false',
    `在收着的标题行上拨开关，这一块没有自己开着，或者里面那一行没跟着变：${probe.leadOpens}`,
  )
  must(probe.disableBar === 1, `改了一项，保存条上不是一项：${probe.disableBar}`)
  must(probe.disabledState === 'disabled', `停用之后状态没变：${probe.disabledState}`)
  same(probe.pickerWithout, ['claude', 'dsh', 'codex'], '停用之后新建会话的选择器不对')
  must(
    /^([1-9]\d*)\/\1$/.test(probe.disabledRows),
    `停用之后它的会话没有都留着并标成不可用：${probe.disabledRows}`,
  )
  must(
    probe.disabledHint.includes('Pi') && probe.disabledHint.includes('停用'),
    `停用之后它的会话里没有说发不了：${probe.disabledHint}`,
  )
  must(probe.leadFollows, '拨了里面那一行的开关，标题行上的开关没有跟着变')
  must(probe.enabledState === 'ready', `再启用之后没有恢复：${probe.enabledState}`)
  same(probe.pickerWith, ['claude', 'pi', 'dsh', 'codex'], '再启用之后新建会话的选择器不对')
  must(probe.enabledRowsDown === 0, `再启用之后它的会话还标着不可用：${probe.enabledRowsDown} 行`)

  same(
    probe.envSaved,
    ['DSH_REGION=cn-east', 'DSH_TOKEN=已设置'],
    '保存之后环境变量表不对（密钥应该只剩“已设置”）',
  )
  must(
    probe.apiKeyAfter === '已设置||password',
    `保存之后密钥那一栏不对（状态|输入框里的字|填的时候的输入框类型）：${probe.apiKeyAfter}`,
  )
  same(probe.secretLeaks, [], '保存之后还找得到刚填的密钥')
  must(
    probe.savedToast.includes('dsh') && probe.savedToast.includes('Pi'),
    `保存之后没有说哪些重新启动了：${probe.savedToast}`,
  )

  must(probe.pendingShown, '改了要重启的设置而它有回合在跑，没有显示“待重启”')
  must(
    probe.pendingToast.includes('Claude Code'),
    `保存之后没有说谁还等着重启：${probe.pendingToast}`,
  )
  must(
    probe.confirmTitle.includes('Claude Code'),
    `它有回合在跑，重启前没有先问：${probe.confirmTitle}`,
  )
  must(probe.stillPending, '说了先不重启，它却变了')
  must(probe.restarted, '说了仍然重启，“待重启”没有收掉')

  must(probe.rangeProblem.includes('1000'), `超出范围没有提示：${probe.rangeProblem}`)
  must(probe.saveBlocked, '有填得不对的栏，“保存”还能按')
  must(probe.refused.includes('端口'), `设备服务不认的那一项没有在那一栏上说明：${probe.refused}`)
  must(probe.refusedKept === 2, `保存被拒之后改动没有都留着：${probe.refusedKept}`)
  must(probe.fixedSaved, '改对之后没有保存成')

  must(
    probe.elsewhereConflict.includes('1 天'),
    `别处改了正在改的那一栏，没有标出最新的值：${probe.elsewhereConflict}`,
  )
  must(probe.elsewhereMine === 'forever', `正在改的那一栏被冲掉了：${probe.elsewhereMine}`)
  must(probe.elsewhereOther === '22340', `没在改的那一栏没有跟着变：${probe.elsewhereOther}`)
  must(probe.elsewhereBlocked, '有一栏被别处改过还没选，“保存”就能按')
  must(probe.keptMine === 'forever:false', `选了“保留我的”再保存，结果不对：${probe.keptMine}`)
  must(
    probe.draftReopened === 'true:false',
    `带着没保存的改动回来，开着的不是有改动的那一节（有改动的那一节:Pi 那一块）：${probe.draftReopened}`,
  )

  must(probe.raceToast.includes('别处'), `保存撞上别处的改动，没有冲突提示：${probe.raceToast}`)
  must(probe.raceConflict, '冲突之后，被别处改过的那一栏没有标出来')
  must(probe.raceOtherKept, '冲突之后，别的栏的改动没有原样留着')
  must(probe.raceLatest === '22440', `选了“用最新的”，显示的不是别处改成的值：${probe.raceLatest}`)
  must(
    probe.raceSaved === '7000:tenMinutes',
    `冲突之后再保存，结果不对（我改的那一项:别处改的那一项）：${probe.raceSaved}`,
  )

  must(
    probe.addedType.startsWith('string:'),
    `设备服务新加的设置项没有显示出来：${probe.addedType}`,
  )
  must(probe.addedSaved === '升级之后加的', `新加的设置项改不了：${probe.addedSaved}`)

  const statuses = new Set(probe.checks.map((check) => check.split(':').at(-1)))
  must(
    probe.checks.length >= 8 && ['ok', 'failed', 'skipped'].every((status) => statuses.has(status)),
    `诊断没有逐项给出结果：${probe.checks.join(' ')}`,
  )
  must(probe.logTail > 50 && probe.logTruncated, `日志的末尾没读到：${probe.logTail} 个字`)
  must(probe.logEmptyNote, '没有内容的日志没有说明')
  same(probe.configAvailable, ['claude', 'pi'], '给得出 ssh 配置片段的入口不对')
  must(probe.configUnavailable.length > 0, '给不出片段的入口没有写原因')
  must(
    probe.copied.includes('Host codex-harness-adapter-claude') && probe.copied.includes('Port '),
    `复制到的不是 ssh 配置片段：${probe.copied}`,
  )
  must(probe.discardUndo === '1>0>1>0', `放弃改动和撤销不对：${probe.discardUndo}`)
  same(probe.remotePending, ['pi'], '远程设备上待重启的 harness 没有显示')
  for (const line of probe.skins) {
    const [where, title, note, lit, name, sum] = line.split(':')
    must(
      Number(title) >= 4.5 &&
        Number(note) >= 3 &&
        Number(lit) >= 1.5 &&
        Number(name) >= 4.5 &&
        Number(sum) >= 3,
      `${where} 下字和底分不开（标题 ${title}、说明 ${note}、开着的开关 ${lit}、harness 的名字 ${name}、摘要 ${sum}）`,
    )
  }
  must(probe.skins.length === 6, `皮肤没有量全：${probe.skins.length}`)
  return failed
}

/** 对着真的设备服务量到的东西，哪些算不合格 */
export function judgeManage(probe: ManageProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const same = (actual: unknown, expected: unknown, what: string) =>
    must(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`,
    )

  must(probe.entry === 'local:1', `设备列表上本机那一行不是“整行一个按钮”：${probe.entry}`)
  must(
    probe.folded === `0/${probe.harnesses.length}`,
    `详情一打开不是“harness 各一行、设置项都收着”（露出来的设置项/标题行）：${probe.folded}`,
  )
  // 夹具里只有 Pi 装着：Claude Code、dsh、OpenCode 和原生 codex 都没装，所以不可用（后三个装了才默认启用）；
  // 经 ACP 接的 Gemini CLI、Qwen Code、acp 默认不启用
  same(
    probe.harnesses,
    [
      'claude-code:unavailable',
      'pi:ready',
      'dsh:unavailable',
      'opencode:unavailable',
      'gemini:disabled',
      'qwen:disabled',
      'acp:disabled',
      'codex:unavailable',
    ],
    '详情页上的 harness 和状态不对',
  )
  const unusable = probe.harnesses.filter((entry) => entry.endsWith(':unavailable')).length
  must(
    probe.downReasons.length === unusable && probe.downReasons.every((reason) => reason.length > 0),
    `用不了的 harness 没有都写原因：${JSON.stringify(probe.downReasons)}`,
  )
  // 真的设备服务给每个 harness 的启用项都标了角色，标题行上各有一个开关（dsh、OpenCode、codex 没装，
  // ACP 那三个默认不启用，都关着）
  same(
    probe.leads,
    [
      'claude-code:true',
      'pi:true',
      'dsh:false',
      'opencode:false',
      'gemini:false',
      'qwen:false',
      'acp:false',
      'codex:false',
    ],
    '每个 harness 的标题行上的启用开关不对（标识:开着没有）',
  )
  for (const type of ['boolean', 'env', 'integer', 'path']) {
    must(
      probe.settingTypes.includes(type),
      `设备服务声明的 ${type} 类型的设置没有画出来：${probe.settingTypes.join()}`,
    )
  }

  must(probe.liveUpdated, '别的客户端改了设置，开着的页面没有跟着变')
  const [latest, written] = probe.tookLatest.split(':')
  must(
    probe.conflictShown.includes(written ?? '\0'),
    `正在改的那一栏被别处改了，没有标出最新的值：${probe.conflictShown}`,
  )
  must(probe.conflictMine, '正在改的那一栏被冲掉了，或者没选之前就能保存')
  must(latest === written, `选了“用最新的”，显示的不是别处改成的值：${probe.tookLatest}`)

  must(probe.disabledState === 'disabled', `停用之后状态没变：${probe.disabledState}`)
  const [down, total, before] = probe.disabledRows.split('/').map(Number)
  must(
    total === before && down === total && (total ?? 0) > 0,
    `停用之后它的会话没有都留着并标成不可用（不可用/现在/原来）：${probe.disabledRows}`,
  )
  must(
    probe.newSessionBlocked.includes('harness') && !probe.pickerHasPi,
    `停用之后还能在它上面新建会话：${probe.newSessionBlocked}`,
  )
  must(
    probe.newSessionWhy.includes('停用') &&
      probe.newSessionWhy.includes('重新启用') &&
      probe.newSessionWhy.endsWith('｜去设备页'),
    `新建对话页上没有说 Pi 是怎么回事、下一步做什么，或者没有去设备页的按钮：${probe.newSessionWhy}`,
  )
  must(
    probe.disabledHint.includes('Pi') && probe.disabledHint.includes('停用'),
    `停用之后打开它的会话，没有说明为什么用不了：${probe.disabledHint}`,
  )
  must(probe.enabledState === 'ready', `再启用之后没有恢复：${probe.enabledState}`)
  must(probe.enabledRowsDown === 0, `再启用之后它的会话还标着不可用：${probe.enabledRowsDown} 行`)
  must(probe.spokeAfterEnable, '再启用之后发不了消息')

  same(
    probe.envSaved,
    ['LITCH_PROBE_REGION=cn-east', 'LITCH_PROBE_TOKEN=已设置'],
    '保存之后环境变量表不对（密钥应该只剩“已设置”）',
  )
  same(probe.secretLeaks, [], '保存之后界面上还找得到刚填的密钥')
  must(probe.savedToast.includes('已保存'), `保存之后没有提示：${probe.savedToast}`)
  must(probe.spokeAfterEnv, '加了环境变量之后发不了消息')

  must(probe.pendingShown, '有请求停着等人时改了要重启的设置，没有显示“待重启”')
  must(probe.confirmTitle.includes('Pi'), `它有回合在跑，重启前没有先问：${probe.confirmTitle}`)
  must(probe.forced, '说了仍然重启，“待重启”没有收掉')
  must(
    probe.restartToast.includes('重新启动') && probe.restartState === 'ready',
    `空闲时重启没有成：${probe.restartToast}（${probe.restartState}）`,
  )

  must(
    probe.checks.length >= 3 && probe.checks.includes('pi:runtime:ok'),
    `诊断没有逐项给出结果：${probe.checks.join(' ')}`,
  )
  must(probe.deviceLog > 0, '设备进程的日志没读到')
  must(probe.runtimeLog > 0, 'Pi 的运行日志没读到')
  same(probe.logLeaks, [], '日志或者界面上出现了刚才填的密钥')

  must(probe.sshBefore === 'off', `SSH 入口一开始不是关着的：${probe.sshBefore}`)
  must(probe.sshOn === 'listening', `打开之后 SSH 入口没有起来：${probe.sshOn}`)
  must(
    probe.copied.includes('Host ') && /Port \d+/.test(probe.copied),
    `复制到的不是 ssh 配置片段：${probe.copied}`,
  )
  must(probe.sshOff === 'off', `关上之后 SSH 入口的状态不对：${probe.sshOff}`)
  must(
    probe.sshListening === '0>1>0',
    `入口的状况那一节，标题后面“几个在监听”没有跟着变：${probe.sshListening}`,
  )
  const [onBefore, onDuring, onAfter] = probe.sshSwitchesOn.split('>').map(Number)
  must(
    onDuring === (onBefore ?? 0) + 1 && onAfter === onBefore,
    `入口那一组设置，标题后面“开着几个”没有跟着变：${probe.sshSwitchesOn}`,
  )
  return failed
}
