// 内置浏览器“从别的浏览器导入”的英文文案。键必须和 zh-CN-bimport.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhBimport } from './zh-CN-bimport.ts'

export const enBimport: Record<keyof typeof zhBimport, Entry> = {
  'bimport.entry.title': 'Import from another browser',
  'bimport.entry.note':
    'Bring cookies (site sign-ins), saved passwords and history from Chrome, Edge, Firefox and others into the built-in browser. A one-time import, not a sync.',
  'bimport.entry.button': 'Import…',
  'bimport.entry.last': 'Last imported on {day}',
  'bimport.menu': 'Browser menu',
  'bimport.menu.import': 'Import cookies and passwords…',
  'bimport.banner':
    'Import cookies and passwords from your usual browser to stay signed in to your sites.',
  'bimport.banner.import': 'Import',
  'bimport.banner.later': 'Not now',

  'bimport.title': 'Import from another browser',
  'bimport.loading': 'Looking for browsers on this computer…',
  'bimport.loadFailed': 'Couldn’t look: {reason}',
  'bimport.none':
    'No browser to import from was found on this computer. Supported: Google Chrome, Microsoft Edge, Brave, Arc, Chromium, Vivaldi and Firefox.',
  'bimport.source': 'From',
  'bimport.profile': 'Profile',
  'bimport.profile.default': '{name} (default)',
  'bimport.block.noProfiles': 'No profile found',
  'bimport.block.nothing': 'Nothing to import',
  'bimport.kinds': 'What to import',
  'bimport.kind.cookies': 'Cookies',
  'bimport.kind.cookies.note': 'Site sign-ins, so you don’t have to sign in again',
  'bimport.kind.passwords': 'Saved passwords',
  'bimport.kind.passwords.note':
    'Kept in Litch’s own password store and filled only in pages you open yourself',
  'bimport.kind.history': 'History',
  'bimport.kind.history.note': 'The last 90 days, suggested as you type in the address bar',
  'bimport.look.unsupported': 'Can’t be read on this computer yet',
  'bimport.look.missing': 'Not in this profile',
  'bimport.domains': 'Only import cookies for these sites',
  'bimport.domains.placeholder': 'github.com, example.com',
  'bimport.domains.note':
    'Domains or URLs, separated by commas or new lines; subdomains are included. Leave unchecked to import all.',
  'bimport.hint.close':
    'Quit {name} completely first (including anything running in the background). While it is open its data files are in use and may not import.',
  'bimport.hint.keychain':
    'macOS will ask whether Litch may use {name}’s key in your keychain when reading cookies and passwords. Choose Allow to import them; if you deny, you can try again.',
  'bimport.hint.systemAuth':
    'Your system will ask for permission when reading cookies and passwords; allow it to import them.',
  'bimport.elevate': 'Allow reading cookies and passwords as administrator',
  'bimport.elevate.note':
    'Reading {name}’s cookies and passwords on this computer needs administrator consent; Windows will show a User Account Control prompt. Without it those two are skipped.',
  'bimport.problem.noSource': 'Choose a browser first',
  'bimport.problem.noKinds': 'Choose at least one',
  'bimport.problem.noDomains':
    'Enter at least one site, or uncheck “Only import cookies for these sites”',
  'bimport.problem.badDomains': 'Not recognized: {list}',
  'bimport.cancel': 'Cancel',
  'bimport.start': 'Import',

  'bimport.running': 'Importing from {name}…',
  'bimport.stage.waiting': 'Waiting',
  'bimport.stage.reading': 'Reading',
  'bimport.stage.writing': 'Saving',
  'bimport.stage.done': 'Done',
  'bimport.stop': 'Stop import',
  'bimport.stopping': 'Stopping…',

  'bimport.overall.ok': 'Import complete',
  'bimport.overall.partial': 'Partly imported',
  'bimport.overall.failed': 'Nothing was imported',
  'bimport.overall.cancelled': 'Import stopped; what was already saved stays',
  'bimport.overall.profileGone':
    'This profile can no longer be found; the browser may have been uninstalled or the profile deleted. Look again and choose one.',
  'bimport.overall.busy': 'Another import is in progress. Try again when it finishes.',
  'bimport.status.ok': 'Done',
  'bimport.status.okFailed': 'Some items couldn’t be saved',
  'bimport.status.empty': 'Nothing in the source',
  'bimport.status.partial': 'Some items couldn’t be read; the rest were imported',
  'bimport.status.missing': 'This profile has none',
  'bimport.status.locked':
    '{name} is still open and its files are in use. Quit it completely and try again.',
  'bimport.status.denied': 'Permission was denied. Choose Allow in the prompt when you try again.',
  'bimport.status.needsElevation':
    'Needs administrator consent. Check “Allow reading cookies and passwords as administrator” below and try again.',
  'bimport.status.unsupported': 'Can’t be read on this computer yet',
  'bimport.status.cancelled': 'Stopped',
  'bimport.status.failed': 'Couldn’t be read; you can try again',
  'bimport.status.skipped': 'Not reached; the import stopped',
  'bimport.count.imported': '{n} imported',
  'bimport.count.existing': '{n} already there',
  'bimport.count.invalid': '{n} invalid',
  'bimport.count.failed': '{n} failed',
  'bimport.count.found': '{n} in the source',
  'bimport.details': 'Details',
  'bimport.retry': 'Try again',
  'bimport.again': 'Choose again',
  'bimport.rescan': 'Look again',
  'bimport.startFailed': 'Couldn’t start: {reason}',
  'bimport.close': 'Close',
  'bimport.done': 'Done',
}
