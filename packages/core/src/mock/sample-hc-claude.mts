// 模拟核心里 Claude Code 的详情设置示例（15 号设计 2.2）：~/.claude/settings.json 的那些项，
// 订阅与 Console 登录（粘贴授权码），API key 和自定义网关（只认环境变量，存 Litch 的设备设置）。
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
  const paste = [field('code', t('授权码（code#state）', 'Authorization code (code#state)'))]
  return {
    config,
    providers: {
      providers: [
        provider(
          'claude-ai',
          t('Claude 订阅（Pro / Max）', 'Claude subscription (Pro / Max)'),
          [
            method('subscription', 'oauthPaste', t('用 claude.ai 登录', 'Sign in with claude.ai'), {
              description: t(
                '在浏览器里授权后，把页面上给的授权码贴回来',
                'Authorize in the browser, then paste the code it shows',
              ),
              fields: paste,
            }),
          ],
          {
            active: true,
            canLogout: true,
            auth: { signedIn: true, kind: 'oauth', label: 'dev@example.com · Max', detail: null },
          },
        ),
        provider('console', t('Anthropic Console', 'Anthropic Console'), [
          method('console', 'oauthPaste', t('用 Console 账号登录', 'Sign in with Console'), {
            fields: paste,
          }),
        ]),
        provider('api-key', t('API key', 'API key'), [
          method('env', 'env', t('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'), {
            envName: 'ANTHROPIC_API_KEY',
            description: t(
              'Claude Code 只从环境变量读：存在 Litch 的设备设置里，启动时注入',
              'Claude Code only reads it from the environment: Litch keeps it in the device settings',
            ),
          }),
        ]),
        provider('gateway', t('自定义网关', 'Custom gateway'), [
          method(
            'base-url',
            'env',
            t('网关地址 ANTHROPIC_BASE_URL', 'Gateway URL ANTHROPIC_BASE_URL'),
            {
              envName: 'ANTHROPIC_BASE_URL',
            },
          ),
          method(
            'token',
            'env',
            t('网关令牌 ANTHROPIC_AUTH_TOKEN', 'Gateway token ANTHROPIC_AUTH_TOKEN'),
            {
              envName: 'ANTHROPIC_AUTH_TOKEN',
            },
          ),
        ]),
      ],
      switchable: true,
      templates: [],
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
