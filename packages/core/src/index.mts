// 核心包的入口。界面和外壳只从这里引用。

// 扫码绑定手机：界面拼二维码文本、外壳造一次性私钥文件要用（和设备进程、手机用的是同一份）
export {
  base64UrlDecode,
  decodePairPayload,
  encodePairPayload,
  isTailnetHost,
  PAIR_PAYLOAD_PREFIX,
  PAIR_TTL_MS,
  type PairPayload,
  tailscaleVerifyUrl,
} from '../../protocol/src/device-pairing.mjs'
// 设备设置里“任务卡”按 harness 的键：设置页那棵树、提案卡上的“对这个 harness 关闭任务卡”都写它
export { taskCardsSettingKey } from '../../protocol/src/session-tree.mjs'
// 日程怎么算：界面的表单拿它预览“下一次”、先查时区（和设备进程用的是同一份）
export {
  isTaskTimeZone,
  localTaskTimeZone,
  MIN_TASK_INTERVAL_MINUTES,
  nextTaskRun,
  type TaskScheduleProblem,
  validateTaskSchedule,
} from '../../protocol/src/task-schedule.mjs'
export { type Cancel, createCancel } from './channel/cancel.mjs'
export { type CoreChannel, connectChannel, type TopicSink } from './channel/client.mjs'
export { createPortPair } from './channel/memory-port.mjs'
export {
  type AbortSignalLike,
  type AccountLimitsOp,
  type AppOp,
  ChannelError,
  type ChannelErrorExtra,
  type ChannelErrorShape,
  type ClientMessage,
  type Clock,
  type CommandName,
  type Commands,
  type DiffOp,
  type HarnessConfigOp,
  type InstallOp,
  type ManageOp,
  type PairingOp,
  type Port,
  type ServerMessage,
  type SessionOp,
  type SidebarOp,
  type TasksOp,
  type Topic,
  type TopicData,
  type TopicKind,
  type TopicOp,
  toChannelError,
} from './channel/protocol.mjs'
export {
  type CoreHost,
  createOpQueue,
  type HostSink,
  type OpQueue,
  type ServeOptions,
  serveChannel,
} from './channel/server.mjs'
export {
  type ConnectFailure,
  createLink,
  type Link,
  type LinkOptions,
  type LinkState,
} from './connection/link.mjs'
export {
  createRpc,
  type Rpc,
  RpcAbortError,
  RpcError,
  type RpcOptions,
  type RpcRequestOptions,
} from './connection/rpc.mjs'
export {
  ConnectError,
  createTransportPair,
  type Transport,
  type TransportHandlers,
  type TransportOpener,
  toConnectError,
} from './connection/transport.mjs'
export {
  type Core,
  type CoreConfigOptions,
  type CoreMachineOptions,
  type CoreOptions,
  createCore,
} from './core.mjs'
export {
  createDevice,
  type Device,
  type DeviceConfig,
  type DeviceHooks,
  type DeviceOptions,
} from './device/device.mjs'
export {
  createDiffs,
  DIFF_BUNDLE_FILES,
  DIFF_LINGER_MS,
  DIFF_LIST_MAX,
  DIFF_UNTRACKED_COUNTED,
  DIFF_WATCH_DELAY_MS,
  DIFF_WATCH_GAP_MS,
  type Diffs,
  type DiffsHost,
} from './device/diffs.mjs'
export { createFiles, type Files, type FilesHost, LIST_TTL_MS } from './device/files.mjs'
export { GIT_CAPS } from './device/git.mjs'
export {
  codexHarness,
  harnessFromInfo,
  harnessFromRuntimeInfo,
  isDeviceRuntime,
} from './device/harness.mjs'
export type { AuthForwardPlatform } from './device/harness-config.mjs'
export {
  hostKeyTrusted,
  type PairEnrollTestInput,
  type PairingHostAddress,
  type PairingPlatform,
  type PairSelfTestInput,
  type PairSelfTestResult,
  pairingPayload,
} from './device/pairing.mjs'
export {
  changeToolSwitches,
  checkPairingAddress,
  checkSaved,
  checkTarget,
  type DeviceStore,
  defaultName,
  hostLabel,
  type MachineLogStore,
  PAIRING_NAME_MAX,
  type RemotePlatform,
  type RemoteUpgradePlatform,
  type SavedDevices,
  type SavedRemote,
  type SavedToolSwitches,
  sameTarget,
  toolSwitchesOf,
  WIRES,
} from './device/remote.mjs'
export { checkSnapshot, type DeviceSnapshot, type SnapshotStore } from './device/snapshot.mjs'
export {
  checkNotes,
  LAUNCH_SCRIPT,
  type LaunchPlan,
  launchPlan,
  type TerminalNotes,
  type TerminalNotesStore,
  WINDOWS_DIRS_ENV,
  WINDOWS_LAUNCH_SCRIPT,
} from './device/terminal-launch.mjs'
export {
  STREAM_LIMITS,
  type StreamLimits,
  type StreamSink,
  TerminalStream,
} from './device/terminal-stream.mjs'
export {
  createTerminals,
  PARK_BYTES,
  type Terminals,
  type TerminalsHost,
} from './device/terminals.mjs'
export { CALL_TIMEOUT_MS } from './device/tool-calls.mjs'
export { projectWorkspaces, resolveWorkspace } from './device/workspaces.mjs'
export { createMockCore, type MockCore, type MockCoreOptions } from './mock/mock-core.mjs'
export type { SampleLang } from './mock/sample-text.mjs'
export type * from './model.mjs'
export type * from './model-background.mjs'
export type * from './model-client-tools.mjs'
export { CLIENT_TOOL } from './model-client-tools.mjs'
export type * from './model-config.mjs'
export type * from './model-diff.mjs'
export { DIFF_SCOPES } from './model-diff.mjs'
export type * from './model-files.mjs'
export type * from './model-goal.mjs'
export type * from './model-harness-config.mjs'
export type * from './model-install.mjs'
export type * from './model-limits.mjs'
export type * from './model-machine.mjs'
export type * from './model-manage.mjs'
export type * from './model-pairing.mjs'
export type * from './model-service.mjs'
export type * from './model-tasks.mjs'
export type * from './model-terminal.mjs'
export type * from './model-tree.mjs'
export {
  AGENT_RUN_STATE,
  agentSettled,
  proposalAsksUser,
  proposalOpen,
  proposalShape,
  proposalStatus,
  proposedBy,
} from './model-tree.mjs'
export {
  describeText,
  type Phrase,
  type PhraseArgs,
  type PhraseKey,
  phrase,
  sameText,
  type Text,
} from './phrase.mjs'
export {
  ASK_TOOL,
  type AskAnswers,
  type AskReply,
  type AskState,
  askQuestionId,
  askReplyText,
  askState,
  gatherAnswers,
  parseAskReply,
} from './projection/asks.mjs'
export {
  deriveBackground,
  runningFromTurn,
  sessionBackground,
  taskOfItem,
  wokenBy,
} from './projection/background.mjs'
export {
  answerOf,
  type Block,
  type BlockInput,
  type BucketOptions,
  bucketItems,
  type CardPlace,
  cardOf,
  cardPlace,
  type ProcessPart,
  type ProcessTally,
  processFolded,
  processItemIds,
  processSettled,
  processTally,
  quietOf,
  type StepKind,
  type StepsTally,
  stepFailed,
  stepKindOf,
  stepsTally,
  thoughtShown,
  toolKind,
} from './projection/blocks.mjs'
export {
  type CommentExtra,
  clipQuote,
  MAX_COMMENTS,
  MAX_QUOTE,
  type ParsedComment,
  type ParsedComments,
  parseComments,
} from './projection/comments.mjs'
export {
  type FileRef,
  type FileRefMode,
  type FileRefSpan,
  type FileScope,
  fileRefOf,
  findFileRefs,
  knownFileRef,
} from './projection/file-refs.mjs'
export {
  flattenTree,
  languageOf,
  MAX_ENTRIES,
  MAX_TEXT_BYTES,
  projectDirectory,
  projectFile,
  sortEntries,
  type TreeListing,
  unreadableGroup,
} from './projection/files.mjs'
export {
  discardKindOf,
  expectedDiscard,
  parseGrepCounts,
  parseRawNumstat,
  parseStatus,
  summarize,
} from './projection/git-output.mjs'
export { goalPursuing, goalReachedIn, goalStalled, projectGoal } from './projection/goal.mjs'
export { countDiffLines, isInlineImage, projectItem, showJson } from './projection/items.mjs'
export {
  bilingual,
  changedKeys,
  looksSecret,
  projectManage,
  projectSnapshot,
} from './projection/manage.mjs'
export { localUserMessage, MAX_EXTRA_TEXT, MAX_IMAGES } from './projection/outgoing.mjs'
export {
  collectAnswers,
  type QuestionEntries,
  type QuestionEntry,
  type QuestionState,
  questionState,
} from './projection/questions.mjs'
export { reduceSession } from './projection/reduce.mjs'
export type { RequestChoice } from './projection/requests.mjs'
export { projectService, projectUpgrade } from './projection/service.mjs'
export {
  itemKey,
  projectSummary,
  projectThread,
  projectTurn,
  sessionStatus,
  threadTitle,
} from './projection/session.mjs'
export {
  newSessionSettings,
  projectDefaults,
  STANDARD_SPEED,
  shownEffort,
  shownSpeed,
} from './projection/settings.mjs'
export { spanned, spanOf, spanOp } from './projection/span.mjs'
export { todoKey } from './projection/todo.mjs'
// 子代理的状态：对话流的那一行、子代理页、信息卡，和“这个回合里还有没做完的子代理”（回合收起的判定）
export {
  agentRunState,
  agentStatesOf,
  agentsUnfinished,
  firstSentence,
  isAgentSpawn,
} from './projection/tree.mjs'
// 回合末尾“正在工作”那一行只在空档出
export { workingShown } from './projection/working.mjs'
export { type FileTrees, fileKeys } from './replica/file-trees.mjs'
export { KeyedStore } from './replica/keyed-store.mjs'
export {
  createReplica,
  type DeviceActivity,
  type GroupTallies,
  type GroupTally,
  groupOfSection,
  keys,
  LOOSE,
  type ManageRevisions,
  type ManageSchema,
  PINNED,
  type ProposalStarts,
  type Replica,
  type SessionChildren,
  type SessionGroups,
  type SessionHarnesses,
  type SessionMeta,
  type SessionNotes,
  type TaskRunsPage,
  type TerminalGroups,
} from './replica/replica.mjs'
export {
  base64Bytes,
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  encodeUtf8,
  textToBase64,
} from './text/bytes.mjs'
export {
  type CappedDiff,
  capDiff,
  type DiffCursor,
  type DiffElision,
  type DiffLine,
  diffLines,
} from './text/diff.mjs'
export { hunksOf, type LineOp, lineDiff } from './text/line-diff.mjs'
export { repairStreamingMarkdown } from './text/markdown-repair.mjs'
export {
  appendOutput,
  appendSkipping,
  type CappedOutput,
  capOutput,
  cutPoints,
  extendSkipping,
  OUTPUT_HEAD,
  OUTPUT_KEEP,
  OUTPUT_REACH,
  OUTPUT_STEP,
  OUTPUT_TAIL,
  type OutputElision,
  outputLength,
  SKIP_AT,
  type SkippingOutput,
  skipOutput,
  utf8Length,
} from './text/output-cap.mjs'
export { type PatchFile, parsePatch, unquotePath } from './text/patch.mjs'
export {
  baseName,
  extensionOf,
  insideRoot,
  isAbsolutePath,
  joinPath,
  normalizePath,
  noTwin,
  type PathTwin,
  parentPath,
  pathTwin,
  privateTwin,
  relativeTo,
  samePath,
  withinRoot,
} from './text/paths.mjs'
export { parseSpans, type SpanNode, spanText, splitSpanLines } from './text/spans.mjs'
export { capParts, PART_CHARS } from './text/tool-cap.mjs'
export {
  type AdapterInstallMethod,
  compareVersions,
  installMethodOf,
} from './text/versions.mjs'
export { createToolHub, type ToolCallHandlers, type ToolHub } from './tool-hub.mjs'
export { type CoreTrace, type TraceLevel, traceError, traceParams } from './trace.mjs'
export {
  parseUpdateFeed,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FEED_URL,
  type UpdateAsset,
  type UpdateFeed,
  type UpdateOffer,
  type UpdatePlatform,
  type UpdateState,
  updateFor,
} from './update-feed.mjs'
