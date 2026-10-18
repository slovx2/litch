// litch_tasks：模型在会话里建、改、删、列出定时任务，立即运行一次。
// 和别的 litch_ 命名空间不同，执行方是设备服务自己，不是桌面端：任务存在设备上，桌面端没连着也能用。
// 所以建会话时带不带它看的是设备有没有 deviceTasks 扩展（设备信息的 extensions），不看桌面端的声明；
// 设备进程替每条通往引擎的连接声明能执行它，调用到了设备进程就自己答，不转给任何客户端。
// 执行的规矩写在 protocol/extensions/device-tasks.json。参数的含义同 device-tasks.mts。
//
// 这个文件只引用 client-tools.mts 和 device-tasks.mts。
import { CLIENT_TOOL_NAMESPACE, type ClientToolNamespaceSpec } from './client-tools.mjs'
import type { TaskSchedule } from './device-tasks.mjs'

/** create 的参数 */
export interface TasksToolCreateArguments {
  name: string
  prompt: string
  schedule: TaskSchedule
  /** 不给是设备所在的时区 */
  timezone?: string
  /** this_thread（默认）：到点在这个会话里接着发；new_thread：每次新建会话，沿用这个会话的 harness、目录和设置 */
  target?: 'this_thread' | 'new_thread'
  /** 不给是 active */
  status?: 'active' | 'paused'
}

/** update 的参数：只改给了的 */
export interface TasksToolUpdateArguments {
  id: string
  name?: string
  prompt?: string
  schedule?: TaskSchedule
  timezone?: string
  status?: 'active' | 'paused'
}

export interface TasksToolIdArguments {
  id: string
}

const SCHEDULE_SCHEMA = {
  description:
    'When to run, in the task timezone. Runs are at least 5 minutes apart. Times are 24-hour HH:MM.',
  oneOf: [
    {
      type: 'object',
      properties: {
        type: { const: 'once' },
        at: { type: 'string', description: 'Local date and time, YYYY-MM-DDTHH:MM.' },
      },
      required: ['type', 'at'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'interval' },
        minutes: { type: 'integer', minimum: 5 },
      },
      required: ['type', 'minutes'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'hourly' },
        intervalHours: { type: 'integer', minimum: 1, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
        days: {
          type: ['array', 'null'],
          items: { enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
        },
      },
      required: ['type', 'intervalHours', 'minute', 'days'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { type: { enum: ['daily', 'weekdays'] }, time: { type: 'string' } },
      required: ['type', 'time'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'weekly' },
        days: {
          type: 'array',
          minItems: 1,
          items: { enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
        },
        time: { type: 'string' },
      },
      required: ['type', 'days', 'time'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'monthly' },
        day: { type: 'integer', minimum: 1, maximum: 31 },
        time: { type: 'string' },
      },
      required: ['type', 'day', 'time'],
      additionalProperties: false,
    },
  ],
}

const ID_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Task id from list or create.' } },
  required: ['id'],
  additionalProperties: false,
}

/** litch_tasks 的定义。说明要短：原生 codex 对命名空间说明有 1024 字的上限 */
export const TASKS_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.tasks,
  description:
    'Scheduled tasks on the device this session runs on. The device runs them on time even when no app is connected. Only create or change tasks when the user asks for it.',
  tools: [
    {
      type: 'function',
      name: 'list',
      description: 'List the scheduled tasks on this device, with their next and last runs.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'create',
      description:
        'Create a scheduled task. By default each run continues this conversation; use target new_thread only when the user wants a fresh session every run.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name, at most 120 characters.' },
          prompt: {
            type: 'string',
            description: 'What to do on each run, written so it makes sense without this chat.',
          },
          schedule: SCHEDULE_SCHEMA,
          timezone: {
            type: 'string',
            description: 'IANA time zone such as Asia/Shanghai. Defaults to the device time zone.',
          },
          target: { enum: ['this_thread', 'new_thread'] },
          status: { enum: ['active', 'paused'] },
        },
        required: ['name', 'prompt', 'schedule'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'update',
      description: 'Change a task. Only the given fields change. Set status to pause or resume it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          prompt: { type: 'string' },
          schedule: SCHEDULE_SCHEMA,
          timezone: { type: 'string' },
          status: { enum: ['active', 'paused'] },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'delete',
      description: 'Delete a task and its run history.',
      inputSchema: ID_SCHEMA,
    },
    {
      type: 'function',
      name: 'run_now',
      description: 'Run a task once now, without changing its schedule.',
      inputSchema: ID_SCHEMA,
    },
  ],
}
