// 模拟核心里 Codex 的详情设置示例：照官方桌面端的那几组（15 号设计 2.1）。
// ChatGPT 登录和一个只认环境变量的自定义 provider 并存；浏览器登录要回调到设备上的 1455 端口。
import {
  configOf,
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

const EFFORTS = [
  opt('minimal', '最低', 'Minimal'),
  opt('low', '低', 'Low'),
  opt('medium', '中', 'Medium'),
  opt('high', '高', 'High'),
  opt('xhigh', '超高', 'Extra high'),
]

export function sampleCodex({ home, remote }: SampleHome): SampleHc {
  const codexHome = `${home}/.codex`
  const settings = [
    spec('model', 'defaults', 'enum', t('模型', 'Model'), {
      default: 'gpt-5.5',
      effect: 'newSession',
      allowCustom: true,
      options: [
        opt('gpt-5.5', 'GPT-5.5'),
        opt('gpt-5.5-mini', 'GPT-5.5 mini'),
        opt('gpt-5.4-codex', 'GPT-5.4 Codex'),
        opt('o5-pro', 'o5 pro'),
      ],
      description: t(
        '新会话默认用的模型。可以手填清单里没有的',
        'Model for new sessions. You can type one that is not listed',
      ),
    }),
    spec('model_reasoning_effort', 'defaults', 'enum', t('推理强度', 'Reasoning effort'), {
      default: 'medium',
      effect: 'newSession',
      options: EFFORTS,
    }),
    spec('service_tier', 'defaults', 'enum', t('速度', 'Speed'), {
      default: 'default',
      options: [
        opt('default', '标准', 'Standard'),
        opt('fast', '快速（更贵）', 'Fast (costs more)'),
      ],
    }),
    spec('approval_policy', 'permissions', 'enum', t('审批策略', 'Approval policy'), {
      default: 'on-request',
      effect: 'newSession',
      options: [
        opt('untrusted', '只信任安全的命令', 'Only trusted commands'),
        opt('on-request', '模型觉得需要时问', 'When the model asks'),
        opt('never', '从不问', 'Never ask'),
      ],
      description: t(
        '管理员的要求里不许“出错时再问”，所以没有这一档',
        'Your admin requirements do not allow “on failure”, so it is not offered',
      ),
    }),
    spec('sandbox_mode', 'permissions', 'enum', t('沙箱', 'Sandbox'), {
      default: 'workspace-write',
      effect: 'newSession',
      options: [
        opt('read-only', '只读', 'Read only'),
        opt('workspace-write', '可写工作区', 'Workspace write'),
        opt('danger-full-access', '完全访问', 'Full access'),
      ],
    }),
    spec(
      'sandbox_workspace_write.network_access',
      'permissions',
      'boolean',
      t('沙箱里允许联网', 'Network in the sandbox'),
      {
        default: false,
        effect: 'newSession',
      },
    ),
    spec(
      'sandbox_workspace_write.writable_roots',
      'permissions',
      'stringList',
      t('额外可写的目录', 'Extra writable roots'),
      {
        default: [],
        description: t('每行一个绝对路径', 'One absolute path per line'),
      },
    ),
    spec('web_search', 'behavior', 'enum', t('网页搜索', 'Web search'), {
      default: 'cached',
      options: [
        opt('disabled', '关', 'Off'),
        opt('cached', '用缓存', 'Cached'),
        opt('live', '实时', 'Live'),
      ],
    }),
    spec('model_verbosity', 'behavior', 'enum', t('输出详细度', 'Verbosity'), {
      default: 'medium',
      options: [
        opt('low', '简短', 'Low'),
        opt('medium', '适中', 'Medium'),
        opt('high', '详细', 'High'),
      ],
    }),
    spec('model_reasoning_summary', 'behavior', 'enum', t('推理摘要', 'Reasoning summary'), {
      default: 'auto',
      options: [
        opt('auto', '自动', 'Auto'),
        opt('concise', '简要', 'Concise'),
        opt('detailed', '详细', 'Detailed'),
        opt('none', '不要', 'None'),
      ],
    }),
    spec(
      'developer_instructions',
      'behavior',
      'text',
      t('附加的开发者指令', 'Developer instructions'),
      {
        default: '',
        effect: 'newSession',
        placeholder: 'Always answer in Chinese.',
        description: t('每个会话开头都会带上', 'Sent at the start of every session'),
      },
    ),
    spec('features.unified_exec', 'features', 'boolean', t('统一的命令执行器', 'Unified exec'), {
      default: false,
      effect: 'harness',
    }),
    spec(
      'features.apply_patch_freeform',
      'features',
      'boolean',
      t('自由格式的补丁工具', 'Freeform apply_patch'),
      {
        default: true,
        effect: 'harness',
      },
    ),
    spec('features.view_image_tool', 'features', 'boolean', t('看图工具', 'View image tool'), {
      default: true,
      effect: 'harness',
    }),
    spec('skills.pdf.enabled', 'tools', 'boolean', t('技能：pdf', 'Skill: pdf'), { default: true }),
    spec(
      'plugins.github@openai-curated.enabled',
      'tools',
      'boolean',
      t('插件：GitHub', 'Plugin: GitHub'),
      {
        default: false,
        effect: 'harness',
      },
    ),
    spec(
      'hooks.state.format-on-save.trusted',
      'tools',
      'boolean',
      t('信任 hook：format-on-save', 'Trust hook: format-on-save'),
      {
        default: false,
        description: t('不信任的 hook 不会执行', 'Untrusted hooks do not run'),
      },
    ),
    spec('memories.generate', 'memory', 'boolean', t('从会话里生成记忆', 'Generate memories'), {
      default: true,
    }),
    spec('memories.use', 'memory', 'boolean', t('使用记忆', 'Use memories'), { default: true }),
    spec(
      'memories.disable_on_external_context',
      'memory',
      'boolean',
      t('有外部上下文时停用', 'Disable with external context'),
      {
        default: false,
      },
    ),
    spec(
      'shell_environment_policy.inherit',
      'advanced',
      'enum',
      t('命令继承的环境变量', 'Inherited environment'),
      {
        default: 'all',
        options: [
          opt('all', '全部', 'All'),
          opt('core', '只要基本的', 'Core only'),
          opt('none', '不继承', 'None'),
        ],
      },
    ),
    spec(
      'shell_environment_policy.set',
      'advanced',
      'json',
      t('命令额外的环境变量', 'Extra environment for commands'),
      {
        default: {},
        description: t('JSON 对象：变量名 → 值', 'JSON object: name → value'),
      },
    ),
    spec(
      'model_auto_compact_token_limit',
      'advanced',
      'integer',
      t('自动压缩的阈值（词元）', 'Auto-compact threshold (tokens)'),
      {
        default: null,
        minimum: 10_000,
        maximum: 2_000_000,
      },
    ),
    spec('history.persistence', 'advanced', 'enum', t('记下输入历史', 'Save input history'), {
      default: 'save-all',
      readOnly: true,
      readOnlyReason: t(
        '被管理员的 requirements.toml 锁住了',
        'Locked by your admin’s requirements.toml',
      ),
      options: [opt('save-all', '全部记下', 'Save all'), opt('none', '不记', 'None')],
    }),
  ]
  const config = configOf(
    [
      GROUPS.defaults,
      GROUPS.permissions,
      GROUPS.behavior,
      GROUPS.features,
      GROUPS.tools,
      GROUPS.memory,
      GROUPS.advanced,
    ],
    settings,
    {
      model: 'gpt-5.5',
      model_reasoning_effort: 'high',
      approval_policy: 'on-request',
      'sandbox_workspace_write.network_access': false,
      web_search: 'live',
      'features.unified_exec': true,
      'skills.pdf.enabled': true,
    },
    {
      overridden: {
        'sandbox_workspace_write.network_access': {
          value: true,
          by: t('配置档 work（profiles.work）', 'profile “work” (profiles.work)'),
        },
      },
      actions: [
        {
          id: 'memory.reset',
          group: 'memory',
          title: t('清空记忆', 'Clear memories'),
          description: t(
            '删掉 Codex 记下的全部记忆，找不回来',
            'Deletes everything Codex remembered; cannot be undone',
          ),
          confirm: t(
            '清空 Codex 在这台设备上的全部记忆？',
            'Clear all of Codex’s memories on this device?',
          ),
          danger: true,
        },
        {
          id: 'mcp.reload',
          group: 'tools',
          title: t('重新加载 MCP 服务', 'Reload MCP servers'),
          description: null,
          confirm: null,
          danger: false,
        },
      ],
      files: [
        { role: 'settings', path: `${codexHome}/config.toml` },
        { role: 'credentials', path: `${codexHome}/auth.json` },
      ],
    },
  )
  const chatgpt = provider(
    'openai',
    t('OpenAI（ChatGPT 账号或 API key）', 'OpenAI (ChatGPT account or API key)'),
    [
      method(
        'chatgpt-browser',
        'oauthBrowser',
        t('用 ChatGPT 登录（浏览器）', 'Sign in with ChatGPT (browser)'),
        {
          description: remote
            ? t(
                '授权完会回调到设备上的 1455 端口，Litch 会先经 ssh 把它转过去',
                'The browser calls back to port 1455 on the device; Litch forwards it over ssh first',
              )
            : null,
        },
      ),
      method(
        'chatgpt-device',
        'oauthDeviceCode',
        t('用 ChatGPT 登录（设备码）', 'Sign in with ChatGPT (device code)'),
      ),
      method('api-key', 'apiKey', t('用 API key', 'Use an API key'), {
        fields: [KEY_FIELD('sk-...')],
      }),
    ],
    {
      active: true,
      canLogout: true,
      auth: {
        signedIn: true,
        kind: 'oauth',
        label: 'dev@example.com · Plus',
        detail: t('本周额度还剩 62%', '62% of this week’s limit left'),
      },
    },
  )
  const litellm = provider(
    'litellm',
    t('公司网关（LiteLLM）', 'Company gateway (LiteLLM)'),
    [
      method('env', 'env', t('环境变量 LITELLM_API_KEY', 'Environment variable LITELLM_API_KEY'), {
        envName: 'LITELLM_API_KEY',
        description: t(
          'Codex 只从环境变量读这个 key：存在 Litch 的设备设置里，启动时注入',
          'Codex only reads this key from the environment: Litch keeps it in the device settings and injects it at start',
        ),
      }),
    ],
    {
      kind: 'custom',
      templateId: 'openai-compatible',
      definition: {
        name: 'LiteLLM',
        base_url: 'https://llm.example.com/v1',
        env_key: 'LITELLM_API_KEY',
        wire_api: 'responses',
      },
      canLogout: false,
    },
  )
  return {
    config,
    providers: {
      providers: [chatgpt, litellm],
      switchable: true,
      templates: [
        {
          id: 'openai-compatible',
          title: t('OpenAI 兼容的服务', 'OpenAI-compatible service'),
          description: t(
            '写进 model_providers，不动 ChatGPT 的登录',
            'Written to model_providers; your ChatGPT login stays',
          ),
          fields: [
            spec('name', '', 'string', t('显示名', 'Display name')),
            spec('base_url', '', 'string', t('地址', 'Base URL'), { placeholder: 'https://…/v1' }),
            spec(
              'env_key',
              '',
              'string',
              t('从哪个环境变量读 key', 'Environment variable for the key'),
              {
                placeholder: 'MY_API_KEY',
              },
            ),
            spec('wire_api', '', 'enum', t('接口', 'Wire API'), {
              default: 'responses',
              options: [opt('responses', 'Responses'), opt('chat', 'Chat Completions')],
            }),
          ],
        },
      ],
      version: 'p1',
    },
    mcp: {
      servers: [
        server('github', 'http', {
          url: 'https://api.githubcopilot.com/mcp/',
          bearerTokenEnvVar: 'GITHUB_PAT',
          extra: { tool_timeout_sec: 60 },
        }),
        server('filesystem', 'stdio', {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem@2026.9.1', `${home}/work`],
          extra: { startup_timeout_sec: 20 },
        }),
        server('linear', 'http', {
          url: 'https://mcp.linear.app/mcp',
          status: { state: 'needsAuth', message: 'OAuth login required' },
        }),
      ],
      transports: ['stdio', 'http'],
      oauth: true,
      extraFields: [
        spec('startup_timeout_sec', '', 'integer', t('启动超时（秒）', 'Startup timeout (s)'), {
          default: 10,
          minimum: 1,
          maximum: 600,
        }),
        spec('tool_timeout_sec', '', 'integer', t('工具超时（秒）', 'Tool timeout (s)'), {
          default: 60,
          minimum: 1,
          maximum: 3600,
        }),
        spec('enabled_tools', '', 'stringList', t('只开这些工具', 'Only these tools'), {
          default: [],
        }),
      ],
      version: 'm1',
      files: [{ role: 'settings', path: `${codexHome}/config.toml` }],
    },
    instructions: instructions(
      `${codexHome}/AGENTS.md`,
      '# 个人约定\n\n- 用中文回答。\n- 改代码之前先读相关的测试。\n',
      remote ? `${codexHome}/AGENTS.override.md` : null,
    ),
    secrets: {},
  }
}

/** 示例里 Codex 浏览器登录回调的端口（和真的一样） */
export const CODEX_CALLBACK_PORT = 1455
