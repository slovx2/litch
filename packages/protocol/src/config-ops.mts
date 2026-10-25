// `litch config` 的操作清单：桌面端核心的执行器（litch_config）必须正好实现这些，产品手册（skills/litch-manual）
// 必须每个都讲到，两边各有检查对着它。加一个操作：先在这里加一行，再改执行器和手册。
//
// 只覆盖 Litch 自己的功能。装 harness、改系统设置这类系统行为 Agent 照官方做法自己做，这里不再包一层
// （用户 2026-10-19：“harness安装本来就是属于系统行为，我们就不再额外包一层。其他能力也一样。只覆盖【Litch相关功能】”）。
//
// 这个文件不引用别的文件。

export interface ConfigOp {
  /** 组，命令行的第一个词 */
  group: string
  /** 动作，第二个词；整组只有一个动作的（status、open、help）是空串 */
  action: string
  /** 会不会改东西。只读的不用确认 */
  write: boolean
  /**
   * 放宽安全的那几项（给 Agent 更大的权力）：执行器先在桌面端弹确认卡，人点允许才生效。
   * 具体哪些参数值算放宽由执行器判断，这里标的是“可能需要”
   */
  guarded?: boolean
  /** 不可逆。手册要求先在对话里问过用户 */
  irreversible?: boolean
}

export const CONFIG_OPS: readonly ConfigOp[] = [
  { group: 'help', action: '', write: false },
  { group: 'status', action: '', write: false },
  { group: 'open', action: '', write: false },

  { group: 'devices', action: 'list', write: false },
  { group: 'devices', action: 'check', write: false },
  { group: 'devices', action: 'add', write: true },
  { group: 'devices', action: 'rename', write: true },
  { group: 'devices', action: 'wire', write: true },
  { group: 'devices', action: 'target', write: true },
  { group: 'devices', action: 'reconnect', write: true },
  { group: 'devices', action: 'remove', write: true, irreversible: true },

  { group: 'tools', action: 'set', write: true, guarded: true },
  { group: 'machine', action: 'set', write: true, guarded: true },
  { group: 'machine', action: 'log', write: false },
  { group: 'machine', action: 'log-clear', write: true, irreversible: true },

  { group: 'settings', action: 'get', write: false },
  { group: 'settings', action: 'set', write: true },

  { group: 'harness', action: 'list', write: false },
  { group: 'harness', action: 'enable', write: true },
  { group: 'harness', action: 'disable', write: true },
  { group: 'harness', action: 'restart', write: true },

  { group: 'phones', action: 'list', write: false },
  { group: 'phones', action: 'pair', write: false },
  { group: 'phones', action: 'revoke', write: true, irreversible: true },

  { group: 'projects', action: 'list', write: false },
  { group: 'projects', action: 'add', write: true },
  { group: 'projects', action: 'remove', write: true },

  { group: 'tasks', action: 'list', write: false },
  { group: 'tasks', action: 'create', write: true },
  { group: 'tasks', action: 'update', write: true },
  { group: 'tasks', action: 'pause', write: true },
  { group: 'tasks', action: 'resume', write: true },
  { group: 'tasks', action: 'run', write: true },
  { group: 'tasks', action: 'delete', write: true, irreversible: true },

  { group: 'look', action: 'set', write: true },
  { group: 'look', action: 'language', write: true },

  { group: 'browser', action: 'links', write: true },
  { group: 'browser', action: 'sites', write: false },
  { group: 'browser', action: 'allow', write: true, guarded: true },
  { group: 'browser', action: 'forget', write: true },
  { group: 'browser', action: 'trust', write: true, guarded: true },
  { group: 'browser', action: 'blocked', write: false },
  { group: 'browser', action: 'block', write: true },
  { group: 'browser', action: 'unblock', write: true, guarded: true },
  { group: 'browser', action: 'clear-data', write: true, irreversible: true },

  { group: 'computer', action: 'status', write: false },
  { group: 'computer', action: 'apps', write: false },
  { group: 'computer', action: 'forget', write: true },

  { group: 'notify', action: 'task-success', write: true },
  { group: 'notify', action: 'sessions', write: true },

  { group: 'diagnose', action: 'run', write: false },
  { group: 'diagnose', action: 'logs', write: false },
  { group: 'diagnose', action: 'ssh-config', write: false },
]

/** “组 动作”，动作为空时就是组名。检查脚本和帮助都用这种写法 */
export function configOpName(op: ConfigOp): string {
  return op.action ? `${op.group} ${op.action}` : op.group
}
