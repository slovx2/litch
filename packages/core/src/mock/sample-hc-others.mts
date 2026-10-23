// 模拟核心里 OpenCode、Pi、dsh 的详情设置示例（15 号设计 2.3–2.5）。
// OpenCode 没有“当前在用的 provider”（按所选模型定），Pi 和 dsh 有；
// 登录方式各家都有一两种：OpenCode 的 Copilot 是设备码、OpenAI 要回调；Pi 有粘贴码和设备码；dsh 的官方账号只有回调。
import {
  configOf,
  field,
  GROUPS,
  instructions,
  KEY_FIELD,
  method,
  opt,
  provider,
  type SampleHc,
  type SampleHome,
  server,
  spec,
  t,
} from './sample-hc-kit.mjs'

const apiKeyMethod = (placeholder: string) =>
  method('api-key', 'apiKey', t('填 API key', 'Enter an API key'), {
    fields: [KEY_FIELD(placeholder)],
  })

const ASK = [opt('ask', '先问', 'Ask'), opt('allow', '允许', 'Allow'), opt('deny', '拒绝', 'Deny')]

export function sampleOpencode({ home }: SampleHome): SampleHc {
  const dir = `${home}/.config/opencode`
  const models = [
    opt('anthropic/claude-sonnet-4-6', 'Anthropic · Claude Sonnet 4.6'),
    opt('openai/gpt-5.5', 'OpenAI · GPT-5.5'),
    opt('github-copilot/gpt-5.5', 'Copilot · GPT-5.5'),
    opt('deepseek/deepseek-v4', 'DeepSeek · V4'),
  ]
  const config = configOf(
    [GROUPS.defaults, GROUPS.permissions, GROUPS.advanced],
    [
      spec('model', 'defaults', 'enum', t('默认模型', 'Default model'), {
        effect: 'newSession',
        allowCustom: true,
        options: models,
        description: t('写成 provider/模型', 'Written as provider/model'),
      }),
      spec(
        'small_model',
        'defaults',
        'enum',
        t('小模型（起标题等）', 'Small model (titles etc.)'),
        {
          allowCustom: true,
          options: models,
        },
      ),
      spec('default_agent', 'defaults', 'enum', t('默认代理', 'Default agent'), {
        default: 'build',
        options: [opt('build', 'build'), opt('plan', 'plan')],
      }),
      spec(
        'disabled_providers',
        'defaults',
        'stringList',
        t('不显示的 provider', 'Hidden providers'),
        {
          default: [],
        },
      ),
      spec('permission.edit', 'permissions', 'enum', t('改文件', 'Edit files'), {
        default: 'allow',
        options: ASK,
      }),
      spec('permission.bash', 'permissions', 'enum', t('运行命令', 'Run commands'), {
        default: 'allow',
        options: ASK,
      }),
      spec('permission.webfetch', 'permissions', 'enum', t('取网页', 'Fetch web pages'), {
        default: 'allow',
        options: ASK,
      }),
      spec('autoupdate', 'advanced', 'enum', t('自动更新', 'Auto-update'), {
        default: 'true',
        options: [
          opt('true', '自动装', 'Install'),
          opt('notify', '只提醒', 'Notify only'),
          opt('false', '关', 'Off'),
        ],
      }),
      spec('share', 'advanced', 'enum', t('分享会话', 'Session sharing'), {
        default: 'manual',
        options: [
          opt('manual', '手动', 'Manual'),
          opt('auto', '自动', 'Auto'),
          opt('disabled', '关', 'Disabled'),
        ],
      }),
    ],
    { model: 'anthropic/claude-sonnet-4-6', 'permission.bash': 'ask' },
    { files: [{ role: 'settings', path: `${dir}/opencode.json` }] },
  )
  return {
    config,
    providers: {
      providers: [
        provider(
          'anthropic',
          t('Anthropic', 'Anthropic'),
          [
            method('claude-max', 'oauthPaste', t('Claude Pro/Max 账号', 'Claude Pro/Max account'), {
              fields: [field('code', t('授权码', 'Authorization code'))],
            }),
            apiKeyMethod('sk-ant-...'),
          ],
          {
            canLogout: true,
            auth: { signedIn: true, kind: 'apiKey', label: '…3f9a', detail: null },
          },
        ),
        provider('openai', t('OpenAI', 'OpenAI'), [
          method('chatgpt', 'oauthBrowser', t('ChatGPT Plus/Pro 账号', 'ChatGPT Plus/Pro account')),
          apiKeyMethod('sk-...'),
        ]),
        provider('github-copilot', t('GitHub Copilot', 'GitHub Copilot'), [
          method('device', 'oauthDeviceCode', t('用 GitHub 登录', 'Sign in with GitHub')),
        ]),
        provider('deepseek', t('DeepSeek', 'DeepSeek'), [apiKeyMethod('sk-...')]),
        provider('my-vllm', t('机房的 vLLM', 'Lab vLLM'), [apiKeyMethod('token')], {
          kind: 'custom',
          templateId: 'openai-compatible',
          canLogout: true,
          definition: {
            name: '机房的 vLLM',
            baseURL: 'http://10.0.3.40:8000/v1',
            models: ['qwen3-coder-480b'],
            apiKey: { set: true },
          },
          auth: { signedIn: true, kind: 'apiKey', label: '…0c21', detail: null },
        }),
      ],
      switchable: false,
      templates: [
        {
          id: 'openai-compatible',
          title: t('OpenAI 兼容', 'OpenAI-compatible'),
          description: t(
            '写进 opencode.json 的 provider，key 存 OpenCode 自己的 auth.json',
            'Added to opencode.json; the key goes to OpenCode’s auth.json',
          ),
          fields: [
            spec('name', '', 'string', t('显示名', 'Display name')),
            spec('baseURL', '', 'string', t('地址', 'Base URL'), { placeholder: 'https://…/v1' }),
            spec('apiKey', '', 'secret', t('API key', 'API key')),
            spec('models', '', 'stringList', t('模型', 'Models'), {
              description: t('每行一个', 'One per line'),
            }),
          ],
          discoverModels: null,
        },
      ],
      version: 'p1',
    },
    mcp: {
      servers: [
        server('context7', 'http', {
          url: 'https://mcp.context7.com/mcp',
          extra: { timeout: 5000 },
        }),
        server('jira', 'stdio', {
          command: 'uvx',
          args: ['mcp-atlassian==0.11.9'],
          env: { JIRA_URL: 'https://jira.example.com', JIRA_API_TOKEN: '' },
          secretKeys: ['JIRA_API_TOKEN'],
          enabled: false,
          status: { state: 'disabled', message: null },
        }),
      ],
      transports: ['stdio', 'http'],
      oauth: true,
      extraFields: [
        spec('timeout', '', 'integer', t('取工具的超时（毫秒）', 'Tool listing timeout (ms)'), {
          default: 5000,
          minimum: 100,
          maximum: 120_000,
        }),
      ],
      version: 'm1',
      files: [{ role: 'settings', path: `${dir}/opencode.json` }],
    },
    // 不存在时 OpenCode 退回去读 ~/.claude/CLAUDE.md
    instructions: instructions(`${dir}/AGENTS.md`, null),
    secrets: { 'my-vllm.apiKey': 'token-lab-0c21' },
  }
}

export function samplePi({ home }: SampleHome): SampleHc {
  const dir = `${home}/.pi/agent`
  const config = configOf(
    [GROUPS.defaults, GROUPS.network, GROUPS.tools, GROUPS.advanced],
    [
      spec('defaultProvider', 'defaults', 'enum', t('默认 provider', 'Default provider'), {
        effect: 'newSession',
        options: [
          opt('anthropic', 'Anthropic'),
          opt('openai-codex', 'ChatGPT (Codex)'),
          opt('kimi', 'Kimi'),
          opt('lab', '机房网关', 'Lab gateway'),
        ],
      }),
      spec('defaultModel', 'defaults', 'enum', t('默认模型', 'Default model'), {
        effect: 'newSession',
        allowCustom: true,
        options: [opt('claude-sonnet-4-6'), opt('claude-opus-4-6'), opt('gpt-5.5'), opt('kimi-k3')],
      }),
      spec('defaultThinkingLevel', 'defaults', 'enum', t('思考强度', 'Thinking level'), {
        default: 'medium',
        options: [
          opt('off', '关', 'Off'),
          opt('low', '低', 'Low'),
          opt('medium', '中', 'Medium'),
          opt('high', '高', 'High'),
        ],
      }),
      spec(
        'enabledModels',
        'defaults',
        'stringList',
        t('切换模型时列出的', 'Models to cycle through'),
        {
          default: [],
        },
      ),
      spec('httpProxy', 'network', 'string', t('HTTP 代理', 'HTTP proxy'), {
        default: '',
        placeholder: 'http://127.0.0.1:7890',
        effect: 'harness',
      }),
      spec('retry.enabled', 'network', 'boolean', t('出错重试', 'Retry on errors'), {
        default: true,
      }),
      spec('retry.maxRetries', 'network', 'integer', t('最多重试几次', 'Max retries'), {
        default: 3,
        minimum: 0,
        maximum: 10,
      }),
      spec('retry.backoffMultiplier', 'network', 'number', t('退避倍数', 'Backoff multiplier'), {
        default: 2,
        minimum: 1,
        maximum: 10,
      }),
      spec('skills.pdf-tools', 'tools', 'boolean', t('技能：pdf-tools', 'Skill: pdf-tools'), {
        default: true,
      }),
      spec(
        'extensions.git-checkpoint',
        'tools',
        'boolean',
        t('扩展：git-checkpoint', 'Extension: git-checkpoint'),
        {
          default: false,
          effect: 'harness',
        },
      ),
      spec('compaction.enabled', 'advanced', 'boolean', t('自动压缩', 'Auto-compact'), {
        default: true,
      }),
      spec(
        'compaction.reserveTokens',
        'advanced',
        'integer',
        t('压缩时留出的词元', 'Reserve tokens'),
        {
          default: 16_384,
          minimum: 1024,
          maximum: 200_000,
        },
      ),
      spec('sessionDir', 'advanced', 'path', t('会话记录放在哪', 'Session directory'), {
        default: `${dir}/sessions`,
        effect: 'harness',
      }),
    ],
    { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6', 'retry.maxRetries': 5 },
    {
      files: [
        { role: 'settings', path: `${dir}/settings.json` },
        { role: 'models', path: `${dir}/models.json` },
        { role: 'credentials', path: `${dir}/auth.json` },
      ],
    },
  )
  return {
    config,
    providers: {
      providers: [
        provider(
          'anthropic',
          t('Anthropic', 'Anthropic'),
          [
            method('claude-max', 'oauthPaste', t('Claude Pro/Max 账号', 'Claude Pro/Max account'), {
              fields: [field('code', t('授权码', 'Authorization code'))],
            }),
            apiKeyMethod('sk-ant-...'),
          ],
          {
            active: true,
            canLogout: true,
            auth: { signedIn: true, kind: 'oauth', label: 'Claude Max', detail: null },
          },
        ),
        provider('openai-codex', t('ChatGPT（Codex 订阅）', 'ChatGPT (Codex plan)'), [
          method('chatgpt', 'oauthBrowser', t('用 ChatGPT 登录', 'Sign in with ChatGPT')),
        ]),
        provider('github-copilot', t('GitHub Copilot', 'GitHub Copilot'), [
          method('device', 'oauthDeviceCode', t('用 GitHub 登录', 'Sign in with GitHub')),
        ]),
        provider('kimi', t('Kimi', 'Kimi'), [
          method(
            'device',
            'oauthDeviceCode',
            t('Kimi 账号（设备码）', 'Kimi account (device code)'),
          ),
          apiKeyMethod('sk-...'),
        ]),
        provider('lab', t('机房网关', 'Lab gateway'), [apiKeyMethod('token')], {
          kind: 'custom',
          templateId: 'models-json',
          canLogout: true,
          definition: {
            baseUrl: 'http://10.0.3.40:8000/v1',
            api: 'openai-completions',
            models: ['qwen3-coder-480b'],
            apiKey: { set: false },
          },
        }),
      ],
      switchable: true,
      templates: [
        {
          id: 'models-json',
          title: t('自定义 provider（models.json）', 'Custom provider (models.json)'),
          description: null,
          fields: [
            spec('baseUrl', '', 'string', t('地址', 'Base URL'), { placeholder: 'https://…/v1' }),
            spec('api', '', 'enum', t('接口', 'API'), {
              default: 'openai-completions',
              options: [
                opt('openai-completions', 'OpenAI Chat Completions'),
                opt('openai-responses', 'OpenAI Responses'),
                opt('anthropic-messages', 'Anthropic Messages'),
              ],
            }),
            spec('apiKey', '', 'secret', t('API key', 'API key')),
            spec('models', '', 'stringList', t('模型', 'Models')),
          ],
          discoverModels: null,
        },
      ],
      version: 'p1',
    },
    mcp: {
      servers: [server('fetch', 'stdio', { command: 'uvx', args: ['mcp-server-fetch==2025.4.7'] })],
      transports: ['stdio', 'http'],
      oauth: false,
      extraFields: [
        spec('lifecycle', '', 'enum', t('什么时候起', 'Start'), {
          default: 'lazy',
          options: [opt('lazy', '用到时', 'On first use'), opt('eager', '一开始', 'At startup')],
        }),
      ],
      version: 'm1',
      files: [{ role: 'mcp', path: `${dir}/mcp.json` }],
    },
    instructions: instructions(`${dir}/AGENTS.md`, '# Pi\n\nKeep answers short.\n'),
    secrets: {},
  }
}

export const DSH_CALLBACK_PORT = 8977

export function sampleDsh({ home }: SampleHome): SampleHc {
  const dir = `${home}/.dsh`
  const config = configOf(
    [GROUPS.defaults, GROUPS.permissions, GROUPS.tools, GROUPS.advanced],
    [
      spec('model', 'defaults', 'enum', t('模型', 'Model'), {
        default: 'deepseek-v4',
        effect: 'newSession',
        options: [opt('deepseek-v4', 'DeepSeek V4'), opt('deepseek-v4-flash', 'DeepSeek V4 Flash')],
      }),
      spec(
        'permissions.preset',
        'permissions',
        'enum',
        t('默认权限预设', 'Default permission preset'),
        {
          default: 'workspace',
          effect: 'newSession',
          options: [
            opt('read-only', '只读', 'Read only'),
            opt('workspace', '工作区', 'Workspace'),
            opt('full', '完全访问', 'Full access'),
          ],
        },
      ),
      spec('sandbox.policy', 'permissions', 'enum', t('沙箱策略', 'Sandbox policy'), {
        default: 'auto',
        options: [
          opt('auto', '自动', 'Auto'),
          opt('strict', '严格', 'Strict'),
          opt('off', '关', 'Off'),
        ],
      }),
      spec('webSearch.enabled', 'tools', 'boolean', t('联网搜索', 'Web search'), {
        default: false,
      }),
      spec('webSearch.apiKey', 'tools', 'secret', t('搜索服务的 key', 'Search API key'), {
        description: t('存在 dsh 的 .credentials.yaml', 'Stored in dsh’s .credentials.yaml'),
      }),
      spec('subagents.maxParallel', 'tools', 'integer', t('同时跑的子代理', 'Parallel subagents'), {
        default: 3,
        minimum: 1,
        maximum: 16,
      }),
      spec('shell.path', 'tools', 'path', t('用哪个 shell', 'Shell'), { default: '/bin/bash' }),
      spec(
        'plugins.code-review',
        'tools',
        'boolean',
        t('插件：code-review', 'Plugin: code-review'),
        {
          default: true,
          effect: 'harness',
        },
      ),
      spec(
        'telemetry.uploadSessions',
        'advanced',
        'boolean',
        t('上传会话日志', 'Upload session logs'),
        {
          default: false,
          readOnly: true,
          readOnlyReason: t(
            'Litch 启动 dsh 时强制关掉了',
            'Litch always turns this off when it starts dsh',
          ),
        },
      ),
    ],
    { model: 'deepseek-v4-flash', 'webSearch.enabled': true, 'webSearch.apiKey': { set: true } },
    {
      files: [
        { role: 'settings', path: `${dir}/settings.yaml` },
        { role: 'credentials', path: `${dir}/.credentials.yaml` },
      ],
    },
  )
  return {
    config,
    providers: {
      providers: [
        provider(
          'deepseek',
          t('DeepSeek', 'DeepSeek'),
          [
            method('account', 'oauthBrowser', t('DeepSeek 账号', 'DeepSeek account'), {
              description: t(
                '只能回调到设备上的 127.0.0.1',
                'Calls back to 127.0.0.1 on the device only',
              ),
            }),
            apiKeyMethod('sk-...'),
          ],
          { active: true },
        ),
        provider('openrouter', t('OpenRouter', 'OpenRouter'), [apiKeyMethod('sk-or-...')]),
        provider('moonshot', t('Moonshot', 'Moonshot'), [apiKeyMethod('sk-...')]),
      ],
      switchable: true,
      templates: [
        {
          id: 'gateway',
          title: t('自定义网关', 'Custom gateway'),
          description: null,
          fields: [
            spec('baseUrl', '', 'string', t('地址', 'Base URL')),
            spec('protocol', '', 'enum', t('协议', 'Protocol'), {
              default: 'anthropic',
              options: [opt('anthropic', 'Anthropic'), opt('openai', 'OpenAI')],
            }),
            spec('model', '', 'string', t('模型', 'Model')),
            spec('apiKey', '', 'secret', t('API key', 'API key')),
          ],
          discoverModels: null,
        },
      ],
      version: 'p1',
    },
    mcp: {
      servers: [
        server('repo-search', 'stdio', {
          command: 'dsh-mcp-search',
          args: ['--root', `${home}/work`],
        }),
      ],
      transports: ['stdio', 'http'],
      oauth: false,
      extraFields: [],
      version: 'm1',
      files: [{ role: 'mcp', path: `${dir}/settings.yaml` }],
    },
    instructions: instructions(`${dir}/AGENTS.md`, null),
    secrets: { 'webSearch.apiKey': 'tvly-sample' },
  }
}
