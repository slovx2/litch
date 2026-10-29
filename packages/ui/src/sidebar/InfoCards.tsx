// 侧栏里设备行、工作区行、会话行的信息卡：行上只留一眼要看的，主机、路径这些细节鼠标停上去才看得到。
import {
  agentRunState,
  type DeviceView,
  keys,
  pathTwin,
  type SessionChildren,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useT } from '../app/appearance.ts'
import { badgeOf, downHarness, nameOf, viaOf, wireStyle } from '../app/device.ts'
import { useKey } from '../app/services.tsx'
import { HarnessList, HarnessWhy } from '../devices/HarnessList.tsx'
import { StatePill } from '../devices/status.tsx'
import { useAgentList } from '../tree/useAgentList.ts'
import { baseName } from '../worktrees/labels.ts'
import { cwdMark } from './cwd.ts'
import { TallyFact } from './TallyMarks.tsx'

/** 一台设备：它是谁、怎么连的、上面有哪些 harness，下面的会话现在各有几个在等人、在跑、没看过 */
export function DeviceInfo({ device }: { device: DeviceView }) {
  const t = useT()
  return (
    <div style={wireStyle(device.wire)}>
      <div className="info-head">
        <i className={device.connection === 'online' ? 'wire-sq' : 'wire-sq off'} />
        <b className="ell">{t.text(device.name)}</b>
        <StatePill device={device} />
      </div>
      <dl className="info-facts">
        <div>
          <dt>{t('devices.host')}</dt>
          <dd className="mono">{device.host}</dd>
        </div>
        <div>
          <dt>{t('devices.via')}</dt>
          <dd>{viaOf(device, t)}</dd>
        </div>
        <div>
          <dt>{t('devices.harness')}</dt>
          <dd>
            <HarnessList device={device} brief />
          </dd>
        </div>
        <TallyFact deviceId={device.id} group={null} />
      </dl>
    </div>
  )
}

interface WorkspaceInfoProps {
  workspace: WorkspaceView
  device: DeviceView
  /** 这个工作区里有几个会话 */
  count: number
}

/** 一个工作区：它在哪台设备的哪个目录，里面有多少会话 */
export function WorkspaceInfo({ workspace, device, count }: WorkspaceInfoProps) {
  const t = useT()
  return (
    <div style={wireStyle(device.wire)}>
      <div className="info-head">
        {workspace.color ? <i className="ws-dot" style={wireStyle(workspace.color)} /> : null}
        <b className="ell">{workspace.name}</b>
      </div>
      <dl className="info-facts">
        <div>
          <dt>{t('info.path')}</dt>
          <dd className="mono">
            {workspace.roots.map((root) => (
              <span key={root} className="info-path">
                {root}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>{t('info.device')}</dt>
          <dd>{t.text(device.name)}</dd>
        </div>
        <div>
          <dt>{t('info.sessions')}</dt>
          <dd>{count}</dd>
        </div>
        <TallyFact deviceId={device.id} group={workspace.id} />
      </dl>
    </div>
  )
}

interface SessionInfoProps {
  summary: SessionSummary
  device: DeviceView
  /** 它归在哪个工作区。没有归属是 undefined */
  workspace: WorkspaceView | undefined
}

/**
 * 一个会话：完整的标题（行上放不下会截断）、它在哪个 harness 上、归在哪个工作区、工作目录
 * （和工作区的根不是一回事的时候多说一句）、是不是置顶了或者在哪个分区里。
 * 它所属的 harness 用不了时，原因和下一步也在这里
 */
export function SessionInfo({ summary, device, workspace }: SessionInfoProps) {
  const t = useT()
  const down = downHarness(device, summary.harness)
  const apart = cwdMark(summary.cwd, workspace?.roots, pathTwin(device.os))
  return (
    <div style={wireStyle(device.wire)} data-session-info={summary.id}>
      <div className="info-head">
        <b className="info-title">{t.text(summary.title)}</b>
      </div>
      <dl className="info-facts">
        <div>
          <dt>{t('devices.harness')}</dt>
          <dd>
            <span className={down ? 'harness-entry down' : 'harness-entry'}>
              <span className={down ? 'chip off' : 'chip'}>{badgeOf(device, summary.harness)}</span>
              {nameOf(device, summary.harness)}
              {down ? <HarnessWhy harness={down} brief /> : null}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('info.workspace')}</dt>
          <dd>{workspace?.name ?? t('workspace.none')}</dd>
        </div>
        {summary.cwd ? (
          <div>
            <dt>{t('info.path')}</dt>
            <dd>
              <span className="info-path mono">{summary.cwd}</span>
              {summary.worktree ? null : apart ? (
                <span className="info-cwd" data-cwd={apart.kind}>
                  {t(apart.kind === 'sub' ? 'info.cwd.sub' : 'info.cwd.away')}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {summary.worktree ? (
          <div>
            <dt>{t('info.worktree')}</dt>
            <dd>
              <span className="mono">{summary.worktree.branch}</span>
              <span className="info-cwd" data-cwd="worktree">
                {summary.worktree.state === 'removed'
                  ? t('info.worktree.removed')
                  : t('info.worktree.from', { base: baseName(summary.worktree.baseRef, t) })}
              </span>
            </dd>
          </div>
        ) : null}
        {summary.pinned || summary.section ? (
          <div>
            <dt>{t('info.place')}</dt>
            <dd>
              {summary.pinned
                ? t('sidebar.pinned')
                : t('info.place.section', { name: summary.section?.name ?? '' })}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('info.device')}</dt>
          <dd>{t.text(device.name)}</dd>
        </div>
        <TreeFacts summary={summary} device={device} />
      </dl>
    </div>
  )
}

/** 列出来的子代理最多几个，再多写个数 */
const AGENTS_SHOWN = 5

/**
 * 会话树的几条：它是谁派出的、怎么派的；下面挂着几个子会话；引擎自己派出的子代理有哪些。
 * 信息卡里不放能点的东西：子代理在对话里的卡片上、侧面板的“子代理”标签里点开
 */
function TreeFacts({ summary, device }: { summary: SessionSummary; device: DeviceView }) {
  const t = useT()
  const lineage = summary.lineage
  // 别的应用派出、认得出父会话的：只写父会话和哪个应用派的
  const native = lineage ? null : summary.nativeLineage
  const parent = useKey<SessionSummary>(
    keys.summary(device.id, lineage?.parentId ?? native?.parentId ?? ''),
  )
  const children = useKey<SessionChildren>(keys.children(device.id))
  const kids = children?.[summary.id]?.length ?? 0
  // 子代理只有完整模式的设备问得到（按父会话列）；卡片出来的时候问一次，几秒内不重复问
  const agents = useAgentList(
    device.id,
    summary.id,
    '',
    device.connection === 'online' && device.mode === 'full' && !summary.lineage,
  )
  return (
    <>
      {lineage ? (
        <>
          <div>
            <dt>{t('info.parent')}</dt>
            <dd>{parent ? t.text(parent.title) : t('tree.lineage.unknown')}</dd>
          </div>
          <div>
            <dt>{t('info.lineage')}</dt>
            <dd>
              {t(lineage.kind === 'fork' ? 'info.lineage.fork' : 'info.lineage.fresh')}
              {' · '}
              {t(`info.lineage.${lineage.origin}`)}
              <span className="info-cwd">
                {t(lineage.wakeParent ? 'info.lineage.wake' : 'info.lineage.noWake')}
              </span>
            </dd>
          </div>
        </>
      ) : native?.parentId ? (
        <>
          <div>
            <dt>{t('info.parent')}</dt>
            <dd>{parent ? t.text(parent.title) : t('tree.lineage.unknown')}</dd>
          </div>
          <div>
            <dt>{t('info.lineage')}</dt>
            <dd>
              {t(
                native.app === 'claude-desktop'
                  ? 'info.lineage.claudeDesktop'
                  : 'info.lineage.otherApp',
              )}
            </dd>
          </div>
        </>
      ) : null}
      {kids > 0 ? (
        <div>
          <dt>{t('info.children')}</dt>
          <dd>{t('info.children.count', { n: kids })}</dd>
        </div>
      ) : null}
      {agents && agents.length > 0 ? (
        <div>
          <dt>{t('info.agents')}</dt>
          <dd className="info-agents">
            {agents.slice(0, AGENTS_SHOWN).map((agent, index) => (
              <span key={agent.id} className="info-agent" data-agent={agent.id}>
                {agent.description || agent.nickname || t('tree.agent.unnamed', { n: index + 1 })}
                {agent.role ? ` (${agent.role})` : ''}
                {' · '}
                {t(`tree.agent.state.${agentRunState(agent, null, null)}`)}
              </span>
            ))}
            {agents.length > AGENTS_SHOWN ? (
              <span className="dim">
                {t('info.agents.more', { n: agents.length - AGENTS_SHOWN })}
              </span>
            ) : null}
          </dd>
        </div>
      ) : null}
    </>
  )
}
