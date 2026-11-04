import type { Thread } from './store.mjs'

export function harnessConfig(
  thread: Thread,
  endpoint: Record<string, unknown>,
  home: string,
  resume: boolean,
): Record<string, unknown> {
  return {
    cascadeId: thread.id,
    sessionContinuationMode: resume ? 'RESUME' : 'CREATE_ONLY',
    appDataDir: home,
    workspaces: [{ filesystemWorkspace: { directory: thread.cwd } }],
    models: [
      {
        name: thread.model,
        types: ['MODEL_TYPE_TEXT'],
        geminiApiEndpoint: { ...endpoint, baseUrl: thread.baseUrl },
      },
    ],
    systemInstructions: {
      appended: {
        appendedSections: [{ title: 'Litch instructions', content: thread.instructions }],
      },
    },
    agentBehavior: 'AGENT_BEHAVIOR_INTERACTIVE',
    harnessSideTools: {
      find: { enabled: true },
      listDir: { enabled: true },
      grepSearch: { enabled: true },
      viewFile: { enabled: true },
      fileEdit: { enabled: true },
      writeToFile: { enabled: true },
      runCommand: {
        enabled: true,
        enableSandbox: false,
        enableDaemonCommands: false,
        maxTimeoutMs: 120000,
        executionMode: 'TOOL_EXECUTION_MODE_SYNC',
      },
      subagents: { enabled: false },
      userQuestions: { enabled: false },
      generateImage: { enabled: false },
      searchWeb: { enabled: false },
      readUrlContent: { enabled: false },
      manageTask: { enabled: false },
      schedule: { enabled: false },
      runWorkflow: { enabled: false },
    },
    policyConfig: {
      rules: [
        {
          tool: '*',
          decision: 'POLICY_DECISION_ASK_USER',
          isDynamic: true,
          ruleId: 'litch_approval',
        },
      ],
      workspaceContainment: 'WORKSPACE_CONTAINMENT_ENABLED',
    },
    retryConfig: { apiRetry: { maxRetries: 0 }, modelOutputRetry: { maxRetries: 0 } },
  }
}
