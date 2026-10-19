// 上手功能的英文文案。键必须和 zh-CN-onboard.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhOnboard } from './zh-CN-onboard.ts'

export const enOnboard: Record<keyof typeof zhOnboard, Entry> = {
  'install.installed': 'Installed {version}',
  'install.notInstalled': 'Not installed',
  'install.verified': 'Verified {version}',
  'install.latest': 'Latest {version}',
  'install.checkingLatest': 'Checking the latest version…',
  'install.noLatest': '(Could not check the latest version: {reason})',
  'install.loading': 'Checking versions…',
  'install.verifiedBtn': 'Install {version}',
  'install.latestBtn': 'Install latest {version}',
  'install.update': 'Update to {version}',
  'install.more': 'Pick another version',
  'install.unverified': 'Unverified',
  'install.unverifiedNote':
    'Litch has not verified this version. It usually works; if it gives you trouble, install the verified one instead',
  'install.running': 'Installing {version}…',
  'install.started': 'Started; waiting for output from the device…',
  'install.done': 'Installed: {version}',
  'install.waitOther': 'Something else is being installed on this device; this one can go after it',
  'install.startFailed': 'Could not start installing {name}: {reason}',
  'install.failed': 'Not installed: {reason}',
  'install.lost': 'The last install did not finish (the device service restarted or disconnected)',
  'install.log.show': 'Show log ({lines} lines)',
  'install.log.hide': 'Hide log',
  'install.manual': 'You can install it yourself in a terminal on the device, the official way:',
  'install.docs': 'Official install guide',
  'install.recheck': 'Check again after installing',
  'install.rechecking': 'Checking…',

  'onboard.title': 'Get started with Litch',
  'onboard.step': 'Step {n}',
  'onboard.close': 'Close (later)',
  'onboard.later': 'Later',
  'onboard.install.title': 'Install a harness first',
  'onboard.install.lead':
    'Litch does not run models itself; conversations go to a harness on this computer (command-line tools such as Claude Code or Codex). None is usable here yet, so install one.',
  'onboard.install.ready': 'Ready {version}',
  'onboard.install.login':
    'Once installed, sign in or set an API key in its own command line (for example, run claude once in a terminal). Litch does not do that for you.',
  'onboard.install.recheck': 'I installed one, check again',
  'onboard.intro.claude':
    "Anthropic's coding assistant and the most complete one: approvals, plans, skills and forks.",
  'onboard.intro.codex': "OpenAI's coding assistant; Litch's protocol follows it.",
  'onboard.intro.pi':
    'A light coding assistant that works with many model providers; no approvals, it acts without asking.',
  'onboard.intro.dsh': "DeepSeek's coding assistant (DeepSeek Harness), still experimental.",
  'onboard.intro.opencode': 'An open-source coding assistant that works with many model providers.',
  'onboard.intro.gemini': "Google's command-line assistant (connected over ACP).",
  'onboard.intro.qwen': "Qwen's command-line assistant (connected over ACP).",
  'onboard.intro.acp': 'Any ACP assistant you connect with your own command.',
  'onboard.intro.other': 'A harness on this computer.',
  'onboard.assist.title': 'Let the config assistant set up Litch',
  'onboard.assist.lead':
    'The config assistant is a conversation with the Litch manual installed: say what you want in plain words and it changes settings with litch config. Anything that widens access asks you here first. For example:',
  'onboard.assist.example.remote': '“Add my server build-01 as a remote device”',
  'onboard.assist.example.phone': '“I want to use Litch on my phone”',
  'onboard.assist.example.harness': '“Turn Pi off and keep only Claude Code”',
  'onboard.assist.example.look': '“Switch to the dark Human skin, a bit larger”',
  'onboard.assist.open': 'Open config assistant',

  'assist.button': '✦ Config assistant',
  'assist.button.note':
    'Start a conversation on this computer that sets Litch up for you using the Litch manual',
  'assist.confirm.title': 'Allow widening access?',
  'assist.confirm.session': 'The model in “{title}” ({harness}) wants to:',
  'assist.confirm.untitled': 'Untitled',
  'assist.confirm.harness': 'The model in {harness} on this computer wants to:',
  'assist.confirm.unknown': 'A model in a harness on this computer wants to:',
  'assist.confirm.computer':
    'Let sessions on {device} use Computer Use (see the screen, click, type)',
  'assist.confirm.machine':
    'Let sessions on {device} use this computer (run commands, read and write files)',
  'assist.confirm.approval': 'Stop asking you when {device} uses this computer',
  'assist.confirm.access':
    'Let {device} touch anything on this computer (no sensitive-place blocks)',
  'assist.confirm.site': 'Always allow {origin} in the built-in browser',
  'assist.confirm.titleErase': 'Allow this deletion?',
  'assist.confirm.erase.device':
    'Remove the remote device {device} (its connection settings go too)',
  'assist.confirm.erase.phone':
    'Revoke the key of the phone “{name}” on {device}; it can no longer connect',
  'assist.confirm.erase.task': 'Delete the scheduled task “{name}” on {device} and its runs',
  'assist.confirm.erase.browserData': 'Clear all built-in browser data (sign-ins, cache and so on)',
  'assist.confirm.erase.machineLog': 'Clear the log of {device} using this computer',
  'assist.confirm.eraseNote': 'This cannot be undone.',
  'assist.confirm.note': 'If nobody answers within two minutes, it counts as declined.',
  'assist.confirm.allow': 'Allow',
  'assist.confirm.decline': 'Decline',
  'assist.section.open': 'Config assistant',
  'assist.section.openNote':
    'Opens a new conversation on this computer with “Use the Litch manual to help me configure:” ready in the box.',
  'assist.section.openButton': 'Open config assistant',
  'assist.section.onboardNote': 'The two-step guide from the first launch.',
  'assist.section.onboardButton': 'Show the guide again',
  'assist.manual.title': 'Product manual',
  'assist.manual.switch': 'Install the product manual into harnesses on this computer',
  'assist.manual.note':
    'Installed as the litch-manual skill, so harnesses here know how Litch works and how to change its settings. Turning this off removes the copies Litch placed.',
  'assist.manual.loading': 'Checking where the manual is installed…',
  'assist.manual.unknown': 'Could not get the manual status.',
  'assist.manual.dir': 'Manual location',
  'assist.manual.error': 'Not installed: {reason}',
  'assist.manual.state.installed': 'Installed',
  'assist.manual.state.linked': 'Linked',
  'assist.manual.state.skipped': 'Skipped',
  'assist.manual.state.failed': 'Failed',
  'assist.manual.state.removed': 'Removed',
  'assist.manual.state.foreign': 'Left alone (not ours)',
  'settings.group.assist': 'Config assistant',
  'settings.assist.intro':
    'Let harnesses on this computer configure Litch for you using the Litch manual; the first-launch guide can be reopened here too.',
}
