// litch_machine 的执行器（接口见 types.mts）。接线那边只调 createMachineExecutor。
//
// 七个工具分在几个文件里：exec 和 process 在 processes.mts（连同进程表），read_file、write_file、list_dir 在
// files.mts，copy 在 copy.mts，machines 在这里。各工具共用的（找机器、审批、看路径）在 common.mts。
// 执行都经 MachineTarget 发协议原有的 process/*、fs/*；fs/* 做不了的（只读一段、取大小、解真实路径、接着写）
// 借 process/spawn 跑小脚本（scripts.mts）。每次调用正好记一条操作记录（context.log），调用从不抛错。
import { clientToolFailure } from '../../../../protocol/src/client-tools.mjs'
import { MACHINE_TOOL, type MachineInfo } from '../../../../protocol/src/client-tools-machine.mjs'
import type { Clock } from '../../channel/protocol.mjs'
import type { MachineAccessMode } from '../../model-machine.mjs'
import { done, errorText, type Outcome, type ToolKit } from './common.mjs'
import { copyTool } from './copy.mjs'
import { listDirTool, readFileTool, writeFileTool } from './files.mjs'
import { execTool, ProcessTable, processTool } from './processes.mjs'
import { createRunner } from './runner.mjs'
import type { MachineCallContext, MachineExecutor } from './types.mjs'

export interface MachineExecutorOptions {
  clock: Clock
  log?(line: string): void
  /** 0 到 1 之间的随机数，起进程句柄用。不给就用 Math.random */
  random?(): number
}

export function createMachineExecutor(options: MachineExecutorOptions): MachineExecutor {
  const debug = options.log ?? (() => {})
  const runner = createRunner(options.clock, options.random ?? Math.random)
  const table = new ProcessTable(options.clock, runner, debug)
  let disposed = false

  const run = async (
    tool: string,
    args: unknown,
    context: MachineCallContext,
  ): Promise<Outcome> => {
    const kit: ToolKit = { clock: options.clock, runner, context, debug }
    switch (tool) {
      case MACHINE_TOOL.machines:
        return machinesTool(context)
      case MACHINE_TOOL.exec:
        return execTool(kit, table, args)
      case MACHINE_TOOL.process:
        return processTool(kit, table, args)
      case MACHINE_TOOL.readFile:
        return readFileTool(kit, args)
      case MACHINE_TOOL.writeFile:
        return writeFileTool(kit, args)
      case MACHINE_TOOL.listDir:
        return listDirTool(kit, args)
      case MACHINE_TOOL.copy:
        return copyTool(kit, args)
      default:
        return {
          response: clientToolFailure('invalid', `litch_machine has no tool named ${tool}.`),
          note: { summary: tool, result: 'failed', flagged: false },
        }
    }
  }

  return {
    async call(tool, args, context) {
      let outcome: Outcome
      if (disposed) {
        outcome = {
          response: clientToolFailure('failed', 'Litch is shutting down.'),
          note: { summary: tool, result: 'failed', flagged: false },
        }
      } else {
        try {
          outcome = await run(tool, args, context)
        } catch (error) {
          // 各工具自己会接住错误；到这里的是没想到的，照样回给模型，不往外抛
          debug(`machine.call.error ${tool} ${errorText(error)}`)
          outcome = {
            response: clientToolFailure('failed', `Litch could not do this: ${errorText(error)}`),
            note: { summary: tool, result: 'failed', flagged: false },
          }
        }
      }
      try {
        context.log({ tool, ...outcome.note, summary: clipSummary(outcome.note.summary || tool) })
      } catch (error) {
        debug(`machine.log.error ${errorText(error)}`)
      }
      return outcome.response
    },
    processes: () => table.records(),
    onProcessesChanged: (listener) => table.onChanged(listener),
    kill: (processId) => table.kill(processId),
    stopAll: (deviceId) => table.stopAll(deviceId),
    ownerPresence: (deviceId, online) => table.ownerPresence(deviceId, online),
    dispose() {
      disposed = true
      table.dispose()
    },
  }
}

/** 记录里的摘要不要太长（命令可能很长） */
const clipSummary = (text: string) => (text.length > 2000 ? `${text.slice(0, 1999)}…` : text)

const APPROVAL_TEXT: Record<MachineInfo['approval'] & string, string> = {
  session:
    'the user approves once per conversation for running commands and writing, and once for reading',
  each: 'the user approves every command and write; reading is approved once per conversation',
  never: 'calls run without asking the user',
}

const ACCESS_TEXT: Record<MachineAccessMode, string> = {
  sensitive: 'common sensitive locations are blocked',
  open: 'no locations are blocked',
  custom: 'the user chose which locations are blocked',
}

async function machinesTool(context: MachineCallContext): Promise<Outcome> {
  const lines: string[] = []
  for (const target of context.targets()) {
    try {
      const facts = await target.facts()
      const info: MachineInfo = {
        id: target.id,
        role: target.role,
        name: facts.name,
        hostname: facts.hostname,
        system: facts.system,
        user: facts.user,
        home: facts.home,
        shell: facts.shell,
        ...(target.role === 'desktop'
          ? { approval: context.settings.approval, access: context.settings.access }
          : {}),
      }
      lines.push(describe(info, context))
    } catch (error) {
      lines.push(
        `- ${target.id} (${roleText(target.role)}): not reachable right now (${errorText(error)})`,
      )
    }
  }
  if (!lines.length) lines.push('No machines are available right now.')
  return done(lines.join('\n'), 'machines')
}

const roleText = (role: MachineInfo['role']) =>
  role === 'desktop'
    ? "the user's desktop running Litch, the controller"
    : role === 'session'
      ? 'where this conversation runs'
      : 'another machine'

function describe(info: MachineInfo, context: MachineCallContext): string {
  const head = `- ${info.id} (${roleText(info.role)}): "${info.name}", host ${info.hostname}, ${info.system}, user ${info.user}, home ${info.home}, shell ${info.shell}`
  if (info.role !== 'desktop' || !info.approval || !info.access) return head
  const denied = context.policy.denied
  const blocked = denied.length ? ` Blocked locations: ${denied.join(', ')}.` : ''
  return `${head}\n  Approval: ${info.approval} (${APPROVAL_TEXT[info.approval]}). Access: ${info.access} (${ACCESS_TEXT[info.access]}).${blocked}`
}
