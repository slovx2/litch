export const zhCN = {
  'privacy.feedback': '反馈或举报内容',
  'privacy.publicFeedback':
    'GitHub issues 是公开渠道。请勿粘贴私钥、源码、完整会话或其他敏感内容。',
  'privacy.licenses': '第三方许可',
  'privacy.continue': '继续',
  'privacy.ai.title': '向 AI 服务发送数据',
  'privacy.ai.detail':
    '消息、附件，以及远程代理读取的项目文件和会话上下文会由以下设备上的工具处理，并可能发送到其配置的 AI 服务。仅发送您有权分享的内容。您可以取消；同意不会授予额外的工具执行权限。',
  'privacy.ai.remote':
    '远程代理按您在该机器上的配置调用服务，由您在远程设备上控制；手机不拦截其自主请求。',
  'privacy.ai.upload':
    '所选文件将先上传到以下设备。发送给 AI 模型时会另行确认数据同意；取消则不上传本次文件。',
  'privacy.ai.unknown':
    '远端未提供完整的供应商信息。请先核实该设备的服务配置。同意将按设备和工具保存；检测到供应商或配置变化后重新询问。您也可在设置中撤回同意。',
  'privacy.ai.delegate':
    '经理或子会话可能继续处理这些内容。下列服务是当前配置；在电脑上更改配置或指示代理选择其他服务前，请重新核实数据去向。',
  'privacy.ai.allow': '同意并继续',
  'privacy.ai.cancelled': '已取消本次操作。',
  'privacy.ai.unavailable': '无法确认远端服务配置，请连接设备后重试。',
  'privacy.ai.reset': '撤回 AI 数据同意',
  'privacy.ai.resetDetail':
    '下次从手机发起 AI 操作前重新询问。已经发送的内容及远端正在运行的任务不会因此被删除或停止。',
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
  'privacy.ai.detail':
    'Your messages, attachments, and project files and conversation context read by remote agents will be processed by tools on the device below and may be sent to their configured AI services. Share only content you are authorized to share. You can cancel. Consent does not grant additional tool permissions.',
  'privacy.ai.remote':
    'Remote agents call services according to your settings on that computer, under your control there. The phone does not intercept their autonomous requests.',
  'privacy.ai.upload':
    'The selected file will first be uploaded to the device below. Consent for the AI service is checked separately when sending it to a model. Cancel to avoid uploading this file.',
  'privacy.ai.unknown':
    'The remote device has not provided complete provider information. Verify its service configuration first. Consent is saved for this device and tool; detected provider or configuration changes require consent again. You can withdraw consent in Settings.',
  'privacy.ai.delegate':
    'Managers or child sessions may continue processing this content. The services below reflect current settings. Before changing settings on the computer or asking an agent to use another service, verify where your data will go.',
  'privacy.ai.allow': 'Agree and continue',
  'privacy.ai.cancelled': 'This action was cancelled.',
  'privacy.ai.unavailable':
    'Could not verify the remote service settings. Connect the device and try again.',
  'privacy.ai.reset': 'Withdraw AI data consent',
  'privacy.ai.resetDetail':
    'Ask again before the next AI action from this phone. This does not delete content already sent or stop tasks running on the remote device.',
  'privacy.tailscale.title': 'Before connecting Tailscale',
  'privacy.tailscale.detail':
    'The selected control server receives node identifiers, public keys, node names, OS and client versions, network addresses and connection metadata to register the node and establish connections. Relays process encrypted traffic and necessary connection records. This path serves Litch SSH connections only, not other apps. You can cancel and use direct SSH.',
  'privacy.tailscale.policy': 'Tailscale privacy policy',
  'privacy.tailscale.custom':
    'Your custom control server operator handles its data. Verify that operator’s privacy policy first.',
}
