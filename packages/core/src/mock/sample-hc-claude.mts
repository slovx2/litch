// 模拟核心里 Claude Code 的详情设置示例（15 号设计 2.2）：~/.claude/settings.json 的那些项，
// 账号（订阅、Console、长期令牌）和用户加的供应商（33 号设计：API key、Anthropic 兼容网关），没有“当前供应商”。

import type { HcConfigView } from '../model-harness-config.mjs'
import {
  configOf,
  field,
  GROUPS,
  instructions,
  method,
  opt,
  provider,
  type SampleHc,
  type SampleHome,
  server,
  spec,
  t,
} from './sample-hc-kit.mjs'

/** 模拟与真实引擎一致：全局 env 覆盖所有行，清掉后各供应商分别生效。 */
export function refreshClaudeContext(config: HcConfigView): void {
  const global = config.values['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW']
  for (const item of config.settings.filter((item) =>
    item.key.startsWith('litch_context_windows.'),
  )) {
    if (typeof global === 'number')
      config.overridden[item.key] = {
        value: global,
        by: t('用户 settings.json env', 'User settings.json env'),
      }
    else delete config.overridden[item.key]
  }
  config.actions =
    typeof global === 'number'
      ? [
          {
            id: 'context-window.use-default',
            group: 'context',
            title: t('改为默认自动压缩窗口', 'Use as default auto-compact window'),
            description: t(
              `将 ${global} 作为默认值，并清除用户 env 覆盖。`,
              `Use ${global} as the default and remove the user env override.`,
            ),
            confirm: t(
              '按供应商与模型的设置将优先生效，现有默认值会被替换。',
              'Provider and model settings will take precedence. The existing default will be replaced.',
            ),
            danger: false,
          },
          {
            id: 'context-window.clear-global',
            group: 'context',
            title: t('清除全局覆盖', 'Clear global override'),
            description: null,
            confirm: t(
              '清除用户 settings.json env 中的全局覆盖？',
              'Remove the global override from user settings.json env?',
            ),
            danger: false,
          },
        ]
      : []
}

export function sampleClaude({ home }: SampleHome): SampleHc {
  const dir = `${home}/.claude`
  const settings = [
    spec('model', 'defaults', 'enum', t('模型', 'Model'), {
      default: 'default',
      effect: 'newSession',
      allowCustom: true,
      options: [
        opt('default', '默认（按套餐）', 'Default (by plan)'),
        opt('sonnet', 'Sonnet'),
        opt('opus', 'Opus'),
        opt('haiku', 'Haiku'),
        opt('opusplan', 'Opus 计划 + Sonnet 执行', 'Opus plan + Sonnet'),
      ],
    }),
    spec('effortLevel', 'defaults', 'enum', t('强度', 'Effort'), {
      default: 'medium',
      effect: 'newSession',
      options: [opt('low', '低', 'Low'), opt('medium', '中', 'Medium'), opt('high', '高', 'High')],
    }),
    spec('fastMode', 'defaults', 'boolean', t('快速模式', 'Fast mode'), { default: false }),
    spec('alwaysThinkingEnabled', 'defaults', 'boolean', t('总是先思考', 'Always think'), {
      default: false,
    }),
    spec(
      'permissions.defaultMode',
      'permissions',
      'enum',
      t('默认权限模式', 'Default permission mode'),
      {
        default: 'default',
        effect: 'newSession',
        options: [
          opt('default', '动手之前先问', 'Ask before acting'),
          opt('acceptEdits', '改文件不问', 'Accept edits'),
          opt('plan', '计划模式', 'Plan mode'),
          opt('bypassPermissions', '什么都不问', 'Bypass permissions'),
        ],
      },
    ),
    spec('permissions.allow', 'permissions', 'stringList', t('直接允许', 'Allow'), {
      default: [],
      placeholder: 'Bash(npm run test:*)',
      description: t('每行一条规则', 'One rule per line'),
    }),
    spec('permissions.ask', 'permissions', 'stringList', t('先问', 'Ask'), { default: [] }),
    spec('permissions.deny', 'permissions', 'stringList', t('拒绝', 'Deny'), {
      default: [],
      placeholder: 'Read(./.env)',
    }),
    spec('outputStyle', 'behavior', 'enum', t('输出风格', 'Output style'), {
      default: 'default',
      options: [
        opt('default', '默认', 'Default'),
        opt('Explanatory', '边做边讲', 'Explanatory'),
        opt('Learning', '带着学', 'Learning'),
      ],
    }),
    spec('language', 'behavior', 'string', t('回答用的语言', 'Response language'), {
      default: '',
      placeholder: 'Chinese',
    }),
    spec('attribution.commit', 'behavior', 'string', t('提交里的署名', 'Commit attribution'), {
      default: 'Co-Authored-By: Claude',
      description: t('留空就不加署名', 'Leave empty for no attribution'),
    }),
    spec(
      'cleanupPeriodDays',
      'behavior',
      'integer',
      t('会话记录保留天数', 'Keep transcripts (days)'),
      {
        default: 30,
        minimum: 1,
        maximum: 3650,
      },
    ),
    spec('autoCompactEnabled', 'behavior', 'boolean', t('自动压缩', 'Auto-compact'), {
      default: true,
    }),
    spec('autoUpdatesChannel', 'advanced', 'enum', t('更新通道', 'Update channel'), {
      default: 'latest',
      options: [opt('latest', '最新', 'Latest'), opt('stable', '稳定', 'Stable')],
    }),
    spec(
      'enabledPlugins.superpowers@claude-plugins',
      'tools',
      'boolean',
      t('插件：superpowers', 'Plugin: superpowers'),
      {
        default: false,
        effect: 'newSession',
      },
    ),
    spec('hooks', 'tools', 'json', t('hooks', 'Hooks'), {
      default: {},
      readOnly: true,
      readOnlyReason: t(
        'hooks 只读列出，要改请直接编辑 settings.json',
        'Hooks are listed read-only; edit settings.json to change them',
      ),
    }),
    spec('autoMemoryEnabled', 'memory', 'boolean', t('自动记忆', 'Auto memory'), { default: true }),
  ]
  const config = configOf(
    [
      GROUPS.defaults,
      { id: 'context', title: t('上下文窗口', 'Context window'), description: null },
      GROUPS.permissions,
      GROUPS.behavior,
      GROUPS.tools,
      GROUPS.memory,
      GROUPS.advanced,
    ],
    settings,
    {
      model: 'opus',
      'permissions.allow': ['Bash(npm run test:*)', 'Bash(git status)'],
      'permissions.deny': ['Read(./.env)'],
      language: 'Chinese',
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'npx biome format --write' }] },
        ],
      },
    },
    {
      overridden: {
        model: {
          value: 'sonnet',
          by: t('环境变量 ANTHROPIC_MODEL', 'environment variable ANTHROPIC_MODEL'),
        },
      },
      files: [
        { role: 'settings', path: `${dir}/settings.json` },
        { role: 'mcp', path: `${home}/.claude.json` },
      ],
    },
  )
  config.settings.push(
    spec(
      'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'context',
      'integer',
      t('全局自动压缩窗口（settings.json env）', 'Global auto-compact window (settings.json env)'),
      {
        minimum: 100_000,
        maximum: 1_000_000,
        description: t(
          '覆盖所有供应商与模型。可改为默认值或清除，按模型设置才会生效。',
          'Overrides every provider and model. Convert or clear it to use model windows.',
        ),
      },
    ),
    spec(
      'autoCompactWindow',
      'context',
      'integer',
      t('默认自动压缩窗口', 'Default auto-compact window'),
      { minimum: 100_000, maximum: 1_000_000 },
    ),
    spec(
      'env.CLAUDE_CODE_DISABLE_1M_CONTEXT',
      'context',
      'boolean',
      t('关闭 1M 上下文', 'Disable 1M context'),
      {
        default: false,
        description: t(
          '自动压缩窗口不能超过模型可用容量，关闭后通常最多 200K。',
          'Auto-compact windows cannot exceed model capacity, normally 200K when disabled.',
        ),
      },
    ),
    ...[
      ['anthropic', '官方账号', 'Account', 'claude-opus-5-5', 400000],
      ['anthropic', '官方账号', 'Account', 'claude-sonnet-5-5', 200000],
      ['work', '工作', 'Work', 'claude-opus-5-5', 300000],
    ].map(([providerId, zh, en, model, value]) => {
      const key = `litch_context_windows.${providerId}.${model}`
      config.values[key] = value
      return spec(
        key,
        'context',
        'integer',
        t(`[${zh}] ${model} 自动压缩窗口`, `[${en}] ${model} auto-compact window`),
        {
          minimum: 100_000,
          maximum: 1_000_000,
          description: t(
            '仅此供应商；在无后台任务的下一回合生效。',
            'For this provider; applies on the next turn without background tasks.',
          ),
        },
      )
    }),
  )
  config.values['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = 500000
  refreshClaudeContext(config)
  const paste = [field('code', t('授权码（code#state）', 'Authorization code (code#state)'))]
  const name = spec('title', 'provider', 'string', t('名字', 'Name'), {
    description: t('模型选单里显示成“[名字] 模型”。', 'Shown as "[Name] model" in the model menu.'),
  })
  const key = spec('apiKey', 'provider', 'secret', t('密钥', 'Key'))
  const keyMethod = method('apiKey', 'apiKey', t('密钥', 'Key'), {
    fields: [field('apiKey', t('密钥', 'Key'))],
  })
  return {
    config,
    providers: {
      providers: [
        provider(
          'anthropic',
          t('Anthropic 账号', 'Anthropic account'),
          [
            method(
              'claudeai',
              'oauthPaste',
              t('Claude 订阅（claude.ai）', 'Claude subscription (claude.ai)'),
              {
                description: t(
                  'Pro、Max、Team、Enterprise 账号。',
                  'Pro, Max, Team or Enterprise plans.',
                ),
                fields: paste,
              },
            ),
            method('console', 'oauthPaste', t('Anthropic Console', 'Anthropic Console'), {
              description: t('按 API 用量计费。', 'Billed by API usage.'),
              fields: paste,
            }),
            method('oauthToken', 'apiKey', t('长期令牌', 'Long-lived token'), {
              description: t(
                '在任何一台登录过的电脑上运行 claude setup-token，把输出的令牌填在这里。',
                'Run claude setup-token on any signed-in computer and paste the token here.',
              ),
              fields: [field('token', t('长期令牌', 'Long-lived token'))],
            }),
          ],
          {
            canLogout: true,
            auth: { signedIn: true, kind: 'oauth', label: 'dev@example.com · max', detail: null },
          },
        ),
        provider('deepseek', t('DeepSeek', 'DeepSeek'), [keyMethod], {
          kind: 'custom',
          templateId: 'anthropicGateway',
          canLogout: true,
          auth: { signedIn: true, kind: 'apiKey', label: '…9f2c · api.deepseek.com', detail: null },
          definition: {
            title: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/anthropic',
            apiKey: { set: true },
            authHeader: 'bearer',
            models: ['deepseek-v4 = DeepSeek V4 | 1M', 'deepseek-v4-flash'],
            smallModel: 'deepseek-v4-flash',
          },
        }),
        provider('work', t('工作', 'Work'), [keyMethod], {
          kind: 'custom',
          templateId: 'anthropicApiKey',
          definition: { title: '工作', apiKey: { set: false } },
        }),
      ],
      switchable: false,
      templates: [
        {
          id: 'anthropicApiKey',
          title: t('Anthropic API key', 'Anthropic API key'),
          description: t(
            'Console 里建的 key，经 x-api-key 发给 Anthropic。可以加几个（比如不同组织的 key）。',
            'A Console API key, sent as x-api-key. Add several for different organizations.',
          ),
          fields: [
            name,
            key,
            spec('baseUrl', 'provider', 'string', t('地址', 'Base URL'), {
              description: t('不填用官方地址。', 'Leave empty for the official endpoint.'),
              placeholder: 'https://api.anthropic.com',
            }),
          ],
          discoverModels: null,
        },
        {
          id: 'anthropicGateway',
          title: t('Anthropic 兼容网关', 'Anthropic-compatible gateway'),
          description: t(
            '自己的网关、代理，或提供 Anthropic 接口的第三方模型服务。',
            'Your own gateway or proxy, or a third-party service with an Anthropic-compatible API.',
          ),
          fields: [
            name,
            spec('baseUrl', 'provider', 'string', t('地址', 'Base URL'), {
              placeholder: 'https://gateway.example.com',
            }),
            key,
            spec('authHeader', 'provider', 'enum', t('密钥放在哪', 'Key header'), {
              default: 'bearer',
              options: [opt('bearer', 'Authorization: Bearer'), opt('apiKey', 'x-api-key')],
            }),
            spec('models', 'provider', 'stringList', t('型号', 'Models'), {
              description: t(
                '每行一个型号 ID，要显示别的名字写成“ID = 名字”，上下文窗口加在后面写成“| 1M”（如 deepseek-v4 = DeepSeek | 1M；不写时 Claude Code 按 200K 算）。从网关拉取时带上它声明的窗口。',
                'One model ID per line; write "ID = Name" for a display name and append "| 1M" for the context window (e.g. deepseek-v4 = DeepSeek | 1M; without it Claude Code assumes 200K). Fetching from the gateway fills in the window it declares.',
              ),
            }),
            spec('smallModel', 'provider', 'string', t('小模型', 'Small model'), {
              description: t(
                'Claude Code 起标题、haiku 档等内部请求用的型号。不填用会话所选的型号。',
                'Used for titles and other internal haiku-tier requests. Defaults to the session model.',
              ),
            }),
            spec('headers', 'provider', 'text', t('额外请求头', 'Extra headers'), {
              description: t('每行一个“名字: 值”。', 'One "Name: Value" per line.'),
            }),
          ],
          discoverModels: 'models',
        },
      ],
      version: 'p1',
    },
    mcp: {
      servers: [
        server('playwright', 'stdio', { command: 'npx', args: ['@playwright/mcp@0.0.41'] }),
        server('postgres', 'stdio', {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres@0.6.2'],
          env: { DATABASE_URL: '', PGSSLMODE: 'require' },
          secretKeys: ['DATABASE_URL'],
          status: { state: 'failed', message: 'connect ECONNREFUSED 127.0.0.1:5432' },
        }),
        server('sentry', 'sse', {
          url: 'https://mcp.sentry.dev/sse',
          status: { state: 'needsAuth', message: null },
        }),
      ],
      transports: ['stdio', 'http', 'sse'],
      oauth: true,
      extraFields: [],
      version: 'm1',
      files: [{ role: 'mcp', path: `${home}/.claude.json` }],
    },
    instructions: instructions(
      `${dir}/CLAUDE.md`,
      '# 偏好\n\n- 先给结论，再给理由。\n- 不确定的地方直接说不确定。\n',
    ),
    secrets: {},
  }
}
