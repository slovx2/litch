// 内置浏览器“从别的浏览器导入”的英文文案。键必须和 zh-CN-bimport.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhBimport } from './zh-CN-bimport.ts'

export const enBimport: Record<keyof typeof zhBimport, Entry> = {
  'bimport.entry.title': 'Import from another browser',
  'bimport.entry.note':
    'One-time import of cookies and saved passwords from Chrome, Edge, Firefox and others. Not kept in sync.',
  'bimport.entry.button': 'Import…',
  'bimport.entry.last': 'Last imported {day}',
  'bimport.menu': 'Browser menu',
  'bimport.menu.import': 'Import cookies and passwords…',
  'bimport.banner': 'Import cookies and passwords from your usual browser to stay signed in.',
  'bimport.banner.import': 'Import',
  'bimport.banner.later': 'Not now',

  'bimport.title': 'Import from another browser',
  'bimport.loading': 'Looking for browsers…',
  'bimport.loadFailed': 'Couldn’t find browsers: {reason}',
  'bimport.none':
    'No supported browser found on this computer. Supported: Google Chrome, Microsoft Edge, Brave, Arc, Chromium, Vivaldi and Firefox.',
  'bimport.unusable': 'Found these browsers, but none has data to import:',
  'bimport.source': 'From',
  'bimport.profile': 'Profile',
  'bimport.profile.default': '{name} (default)',
  'bimport.block.noProfiles': 'No profile found',
  'bimport.block.nothing': 'Nothing to import',
  'bimport.kinds': 'What to import',
  'bimport.kind.cookies': 'Cookies',
  'bimport.kind.passwords': 'Saved passwords',
  'bimport.kind.passwords.note':
    'Saved to Litch’s password store for autofill in the built-in browser',
  'bimport.look.unsupported': 'Not supported on this computer yet',
  'bimport.look.missing': 'Not in this profile',
  'bimport.domains': 'Only import cookies for these sites',
  'bimport.domains.placeholder': 'github.com, example.com',
  'bimport.domains.note':
    'Domains or URLs, separated by commas or new lines. Subdomains are included.',
  'bimport.hint.close':
    'Quit {name} completely first, including background processes. Its data files may be locked while it’s open.',
  'bimport.hint.keychain':
    'macOS will ask for access to {name}’s key in your keychain. Choose Allow to import. If you deny, you can try again.',
  'bimport.hint.systemAuth': 'Your system will ask for permission. Allow it to import.',
  'bimport.hint.appBound':
    'This version can’t import protected data (mostly cookies) from recent {name} on Windows. Everything else is imported.',
  'bimport.problem.noSource': 'Choose a browser',
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
  'bimport.overall.partial': 'Partially imported',
  'bimport.overall.failed': 'Import failed',
  'bimport.overall.existing': 'Nothing new. Everything is already in Litch.',
  'bimport.overall.nothing': 'Nothing imported',
  'bimport.overall.cancelled': 'Import stopped. Data already saved is kept.',
  'bimport.overall.profileGone':
    'This profile can’t be found. The browser may have been uninstalled or the profile deleted. Look again and choose another.',
  'bimport.overall.busy': 'Another import is in progress. Try again when it finishes.',
  'bimport.status.ok': 'Done',
  'bimport.status.okFailed': 'Some items couldn’t be saved',
  'bimport.status.allExisting': 'All already exist',
  'bimport.status.allInvalid': 'All invalid; nothing imported',
  'bimport.status.storeUnavailable':
    'Secure storage isn’t available on this computer, so passwords can’t be saved',
  'bimport.status.empty': 'Nothing in the source',
  'bimport.status.partial': 'Some items weren’t imported',
  'bimport.status.missing': 'None in this profile',
  'bimport.status.locked':
    '{name} is still running and its files are locked. Quit it completely and try again.',
  'bimport.status.denied': 'Permission denied. Choose Allow when you try again.',
  'bimport.status.needsElevation':
    'This version can’t import protected data (mostly cookies) from recent Chromium-based browsers on Windows. Everything else is imported.',
  'bimport.status.unsupported': 'Not supported on this computer yet',
  'bimport.status.cancelled': 'Stopped',
  'bimport.status.failed': 'Failed',
  'bimport.status.skipped': 'Skipped; the import stopped',
  'bimport.count.imported': '{n} imported',
  'bimport.count.existing': '{n} already exist',
  'bimport.count.invalid': '{n} invalid',
  'bimport.count.failed': '{n} failed',
  'bimport.count.found': '{n} in the source',
  'bimport.details': 'Details',
  'bimport.retry': 'Try again',
  'bimport.again': 'Choose again',
  'bimport.rescan': 'Look again',
  'bimport.startFailed': 'Couldn’t start: {reason}',
  'bimport.refused': 'Litch didn’t accept this import. Close the dialog and try again.',
  'bimport.close': 'Close',
  'bimport.done': 'Done',
}
