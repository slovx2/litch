// 上手功能的英文文案。键必须和 zh-CN-onboard.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhOnboard } from './zh-CN-onboard.ts'

export const enOnboard: Record<keyof typeof zhOnboard, Entry> = {
  'install.installed': 'Installed {version}',
  'install.notInstalled': 'Not installed',
  'install.verified': 'Verified {version}',
  'install.latest': 'Latest {version}',
  'install.checkingLatest': 'Checking for the latest version…',
  'install.noLatest': '(Couldn’t check for the latest version: {reason})',
  'install.loading': 'Checking versions…',
  'install.verifiedBtn': 'Install {version}',
  'install.latestBtn': 'Install latest {version}',
  'install.update': 'Update to {version}',
  'install.more': 'Other versions',
  'install.unverified': 'Unverified',
  'install.unverifiedNote':
    'Not verified by Litch. It usually works; if you run into problems, install the verified version',
  'install.running': 'Installing {version}…',
  'install.started': 'Started. Waiting for output from the device…',
  'install.done': 'Installed: {version}',
  'install.waitOther':
    'Another install is in progress on this device. This one can start after it finishes',
  'install.startFailed': 'Couldn’t start installing {name}: {reason}',
  'install.failed': 'Install failed: {reason}',
  'install.lost': 'The last install didn’t finish (the device service restarted or disconnected)',
  'install.log.show': 'Show log ({lines} lines)',
  'install.log.hide': 'Hide log',
  'install.manual': 'Or install it manually in a terminal on the device:',
  'install.docs': 'Official install guide',
  'install.recheck': 'Check again after installing',
  'install.rechecking': 'Checking…',

  'onboard.title': 'Get started with Litch',
  'onboard.step': 'Step {n}',
  'onboard.close': 'Close',
  'onboard.later': 'Later',
  'onboard.install.title': 'Install a harness',
  'onboard.install.lead':
    'Litch doesn’t run models itself. Conversations are handled by a harness on this computer, a command-line tool such as Claude Code or Codex. None is available yet, so install one first.',
  'onboard.install.ready': 'Ready {version}',
  'onboard.install.login':
    'After installing, sign in or set an API key in its own CLI (for example, run claude once in a terminal). Litch doesn’t do this for you.',
  'onboard.install.recheck': 'Installed, check again',
  'onboard.intro.claude':
    'Anthropic’s coding assistant, with the most features: approvals, plans, skills and forks.',
  'onboard.intro.codex': 'OpenAI’s coding assistant. Litch’s protocol is based on it.',
  'onboard.intro.pi':
    'A lightweight coding assistant that supports many model providers. It has no approvals and acts without asking.',
  'onboard.intro.dsh': 'DeepSeek’s coding assistant (DeepSeek Harness). Experimental.',
  'onboard.intro.opencode': 'An open-source coding assistant that supports many model providers.',
  'onboard.intro.gemini': 'Google’s CLI assistant, connected over ACP.',
  'onboard.intro.qwen': 'Qwen’s CLI assistant, connected over ACP.',
  'onboard.intro.acp': 'Any ACP agent connected with a custom command.',
  'onboard.intro.other': 'A harness on this computer.',
  'onboard.assist.title': 'Set up Litch with the config assistant',
  'onboard.assist.lead':
    'The config assistant is a conversation with the Litch manual loaded. Describe what you want and it changes settings with litch config. Anything that widens access asks you here first. For example:',
  'onboard.assist.example.remote': '“Add my server build-01 as a remote device”',
  'onboard.assist.example.phone': '“I want to use Litch on my phone”',
  'onboard.assist.example.harness': '“Turn off Pi and keep only Claude Code”',
  'onboard.assist.example.look': '“Switch to the dark Human skin with larger text”',
  'onboard.assist.open': 'Open config assistant',

  'assist.button': '✦ Config assistant',
  'assist.button.note':
    'Start a conversation on this computer that configures Litch using its manual',
  'assist.confirm.title': 'Allow wider access?',
  'assist.confirm.session': 'The model in “{title}” ({harness}) requests:',
  'assist.confirm.untitled': 'Untitled',
  'assist.confirm.harness': 'The model in {harness} on this computer requests:',
  'assist.confirm.unknown': 'A model in a harness on this computer requests:',
  'assist.confirm.computer':
    'Let sessions on {device} use Computer Use (see the screen, click, type)',
  'assist.confirm.machine':
    'Let sessions on {device} use this computer (run commands, read and write files)',
  'assist.confirm.approval': 'Stop asking when {device} uses this computer',
  'assist.confirm.access':
    'Let {device} access anything on this computer (sensitive locations not blocked)',
  'assist.confirm.site': 'Always allow {origin} in the built-in browser',
  'assist.confirm.trustAll':
    'Trust all sites in the built-in browser without asking (except blocked sites)',
  'assist.confirm.unblock': 'Remove {host} from the built-in browser blocklist',
  'assist.confirm.unblockAll': 'Clear the built-in browser blocklist',
  'assist.confirm.titleErase': 'Allow deletion?',
  'assist.confirm.erase.device': 'Remove the remote device {device} and its connection settings',
  'assist.confirm.erase.phone':
    'Revoke the key of phone “{name}” on {device}. It will no longer be able to connect',
  'assist.confirm.erase.task': 'Delete the scheduled task “{name}” on {device} and its runs',
  'assist.confirm.erase.browserData': 'Clear all built-in browser data (sign-ins, cache, etc.)',
  'assist.confirm.erase.machineLog': 'Clear the log of {device}’s actions on this computer',
  'assist.confirm.eraseNote': 'This can’t be undone.',
  'assist.confirm.note': 'Declined automatically if not answered within 2 minutes.',
  'assist.confirm.allow': 'Allow',
  'assist.confirm.decline': 'Decline',
  'assist.section.open': 'Config assistant',
  'assist.section.openNote':
    'Opens a new conversation on this computer with “Use the Litch manual to help me configure:” prefilled.',
  'assist.section.openButton': 'Open config assistant',
  'assist.section.onboardNote': 'The first-launch guide.',
  'assist.section.onboardButton': 'Reopen guide',
  'assist.manual.title': 'Product manual',
  'assist.manual.switch': 'Install the product manual for harnesses on this computer',
  'assist.manual.note':
    'Installed as the litch-manual skill so local harnesses know how Litch works and how to configure it. Turning this off removes the copies Litch installed.',
  'assist.manual.loading': 'Checking where the manual is installed…',
  'assist.manual.unknown': 'Couldn’t get the manual status.',
  'assist.manual.dir': 'Manual location',
  'assist.manual.error': 'Install failed: {reason}',
  'assist.manual.state.installed': 'Installed',
  'assist.manual.state.linked': 'Linked',
  'assist.manual.state.skipped': 'Skipped',
  'assist.manual.state.failed': 'Failed',
  'assist.manual.state.removed': 'Removed',
  'assist.manual.state.foreign': 'Name in use, left unchanged',
  'settings.group.assist': 'Config assistant',
  'settings.assist.intro': 'Let harnesses on this computer configure Litch using the Litch manual.',
}
