export const zhCN = {
  'privacy.feedback': '反馈或举报内容',
  'privacy.publicFeedback':
    'GitHub issues 是公开渠道。请勿粘贴私钥、源码、完整会话或其他敏感内容。',
  'privacy.licenses': '第三方许可',
  'privacy.continue': '继续',
  'privacy.ai.title': '向 AI 服务发送数据',
  'privacy.ai.launchDetail':
    '您发送的消息、附件，以及远程代理读取的项目文件和会话上下文，会发往您选择的电脑或服务器，再由其配置的第三方 AI 服务处理。经理和子会话也可能继续处理这些内容。仅分享您有权提供的数据。',
  'privacy.ai.launchServices':
    '数据去向取决于您在远程设备上配置的工具和供应商，例如 OpenAI、Anthropic、Google 或您自行指定的 API 服务。使用前请在设备的工具设置中核实实际供应商及其隐私政策；Litch 不保证只在本地处理数据。',
  'privacy.ai.launchScope':
    '同意适用于您之后选用的设备、工具及服务，包括将来更改的配置。应用升级和供应商变化不会再次询问。您可以在设置中查看说明或撤回；同意不会授予额外的工具权限，也不会停止或控制远程代理的自主请求。',
  'privacy.ai.required':
    '尚未同意 AI 数据使用，本次操作未执行。请先查看告知并同意，再重新发送；草稿会保留。',
  'privacy.ai.review': '去同意',
  'privacy.ai.settings': 'AI 数据使用',
  'privacy.ai.decline': '不同意',
  'privacy.ai.saveFailed': '无法保存您的选择，请重试。',

  'privacy.ai.allow': '同意并继续',
  'privacy.ai.reset': '撤回 AI 数据同意',
  'privacy.ai.resetDetail':
    '撤回后，从手机发起 AI 操作前需要到设置中重新同意。已经发送的内容及远端正在运行的任务不会因此被删除或停止。',
  'privacy.tailscale.title': '连接 Tailscale 前',
  'privacy.tailscale.detail':
    '所选控制服务器会接收节点标识、公钥、节点名、系统与客户端版本、网络地址和连接元数据，用于注册节点和建立连接；中继服务会处理加密流量及必要的连接记录。此连接仅用于 Litch 自身的 SSH，不接管其他 App 的流量。取消后仍可使用普通 SSH。',
  'privacy.tailscale.policy': 'Tailscale 隐私政策',
  'privacy.tailscale.custom': '自定义控制服务器由其运营者负责数据处理，请先核实其隐私政策。',
} as const

export const en: Record<keyof typeof zhCN, string> = {
  'privacy.feedback': 'Feedback or report content',
  'privacy.publicFeedback':
    'GitHub issues are public. Do not include private keys, source code, full conversations or other sensitive information.',
  'privacy.licenses': 'Third-party licenses',
  'privacy.continue': 'Continue',
  'privacy.ai.title': 'Share data with AI services',
  'privacy.ai.launchDetail':
    'Messages, attachments, and project files and conversation context read by remote agents go to the computer or server you select and then to its configured third-party AI services. Managers and child sessions may also process this content. Share only data you are authorized to provide.',
  'privacy.ai.launchServices':
    'Recipients depend on the tools and providers you configure on your remote devices, such as OpenAI, Anthropic, Google, or your chosen API service. Check the actual provider and its privacy policy in the device’s tool settings before use. Litch does not guarantee local-only processing.',
  'privacy.ai.launchScope':
    'Consent covers devices, tools and services you select later, including future configuration changes. App upgrades and provider changes will not ask again. Review or withdraw consent in Settings. Consent grants no additional tool permissions and does not stop or control autonomous requests from remote agents.',
  'privacy.ai.required':
    'AI data use has not been approved. This action was not performed. Review and agree, then send again. Your draft is kept.',
  'privacy.ai.review': 'Review and agree',
  'privacy.ai.settings': 'AI data use',
  'privacy.ai.decline': 'Do not agree',
  'privacy.ai.saveFailed': 'Could not save your choice. Please try again.',

  'privacy.ai.allow': 'Agree and continue',
  'privacy.ai.reset': 'Withdraw AI data consent',
  'privacy.ai.resetDetail':
    'After withdrawal, review and agree in Settings before starting another AI action from this phone. This does not delete content already sent or stop tasks running on the remote device.',
  'privacy.tailscale.title': 'Before connecting Tailscale',
  'privacy.tailscale.detail':
    'The selected control server receives node identifiers, public keys, node names, OS and client versions, network addresses and connection metadata to register the node and establish connections. Relays process encrypted traffic and necessary connection records. This path serves Litch SSH connections only, not other apps. You can cancel and use direct SSH.',
  'privacy.tailscale.policy': 'Tailscale privacy policy',
  'privacy.tailscale.custom':
    'Your custom control server operator handles its data. Verify that operator’s privacy policy first.',
}
