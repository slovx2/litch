// litch config 的帮助：中英各一份，按命令行给的语言（没给用界面的）。用法和一句话说明来自每个操作自己（OpSpec）。
import { CONFIG_OPS, configOpName } from '../../../protocol/src/config-ops.mjs'
import { groups } from './argv.mjs'
import type { Lang, OpSpec } from './context.mjs'

const GROUP_NOTES: Record<string, { zh: string; en: string }> = {
  help: { zh: '帮助', en: 'Help' },
  status: { zh: '总览', en: 'Overview' },
  open: { zh: '在桌面端打开某一页', en: 'Open a page in the desktop app' },
  devices: {
    zh: '设备：添加、改名、线色、连接、重连、移除',
    en: 'Devices: add, rename, wire color, target, reconnect, remove',
  },
  tools: {
    zh: '设备的会话能用这台桌面的哪些能力',
    en: 'Which desktop abilities sessions on a device may use',
  },
  machine: {
    zh: '远程设备操作这台电脑：审批、访问范围、操作记录',
    en: 'Remote devices using this computer: approval, access, log',
  },
  settings: {
    zh: '设备设置（harness 开关、命令行路径、环境变量、定时任务、会话编排等）',
    en: 'Device settings (harness switches, CLI paths, env, tasks, orchestration, …)',
  },
  harness: { zh: 'harness 的状态、启用停用、重启', en: 'Harness state, enable/disable, restart' },
  phones: { zh: '扫码绑定的手机', en: 'Paired phones' },
  projects: { zh: '设备上的项目', en: 'Projects on a device' },
  tasks: { zh: '定时任务', en: 'Scheduled tasks' },
  look: { zh: '外观和语言', en: 'Look and language' },
  browser: { zh: '内置浏览器', en: 'Built-in browser' },
  computer: { zh: 'Computer Use', en: 'Computer Use' },
  notify: { zh: '通知', en: 'Notifications' },
  diagnose: { zh: '诊断、日志、ssh 配置片段', en: 'Diagnostics, logs, ssh config snippet' },
}

const INTRO = {
  zh: [
    'litch config：配置 Litch。要 Litch 桌面端开着。',
    '<device> 写设备的标识、名字或 local（本机）。加 --json 输出结构化结果。',
    '不可逆的（移除设备、撤销手机、删任务、清除浏览数据、清掉操作记录）先在对话里问过用户。',
    '放宽安全的（打开 Computer Use 或“操作这台电脑”、审批改成不问、访问范围全放开、一直允许网站）会在桌面端弹确认卡，用户点允许才生效。',
    '装 harness、系统权限、harness 自己的登录不归这里管。',
  ],
  en: [
    'litch config: configure Litch. The Litch desktop app must be running.',
    '<device> is a device id, its name, or local (this computer). Add --json for structured output.',
    'Irreversible ops (remove a device, revoke a phone, delete a task, clear browser data, clear the log): ask the user in the conversation first.',
    'Ops that widen access (turn on Computer Use or "use this computer", never-ask approval, open access, always-allow a site) show a confirmation card on the desktop and take effect only if the user allows.',
    'Installing harnesses, system permissions and harness logins are not handled here.',
  ],
}

const pick = (lang: Lang, text: { zh: string; en: string }) =>
  lang === 'zh-CN' ? text.zh : text.en

const TASKS_NOTE = {
  zh: '日程：once 2026-10-20T09:00 · every 30m · hourly 2[:15] · daily 09:00 · weekdays 09:00 · weekly mon,fri 09:00 · monthly 1 09:00，或者 JSON。',
  en: 'Schedules: once 2026-10-20T09:00 · every 30m · hourly 2[:15] · daily 09:00 · weekdays 09:00 · weekly mon,fri 09:00 · monthly 1 09:00, or JSON.',
}

export function helpText(lang: Lang, group: string | null, specs: Record<string, OpSpec>): string {
  if (group === null) {
    const lines = [...(lang === 'zh-CN' ? INTRO.zh : INTRO.en), '']
    for (const name of groups()) {
      const note = GROUP_NOTES[name]
      lines.push(`${name}${note ? ` — ${pick(lang, note)}` : ''}`)
      for (const op of CONFIG_OPS.filter((entry) => entry.group === name)) {
        const spec = specs[configOpName(op)]
        if (spec && name !== 'help') lines.push(`  litch config ${spec.usage}`)
      }
    }
    lines.push(
      '',
      lang === 'zh-CN'
        ? '某一组的说明：litch config <组> --help'
        : 'Details: litch config <group> --help',
    )
    return lines.join('\n')
  }
  const note = GROUP_NOTES[group]
  const lines = [`${group}${note ? ` — ${pick(lang, note)}` : ''}`]
  for (const op of CONFIG_OPS.filter((entry) => entry.group === group)) {
    const spec = specs[configOpName(op)]
    if (!spec) continue
    lines.push(`  litch config ${spec.usage}`, `      ${pick(lang, spec.summary)}`)
  }
  if (group === 'tasks') lines.push('', pick(lang, TASKS_NOTE))
  return lines.join('\n')
}
