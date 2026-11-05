export const enChrome = {
  'chrome.tab': 'Allow control of this Chrome tab?',
  'chrome.tabAllow': 'Allow control',
  'chrome.trustDone':
    'All Chrome sites are trusted. Manage this and the blocklist in Settings → Chrome.',
  'chrome.instance': 'Allow access to this Chrome instance',
  'chrome.instanceLabel': 'Instance',
  'chrome.instanceNote':
    'Allow the agent to list tab titles and URLs in this Chrome instance. Page access follows Chrome site permissions; user tabs still require individual claims.',
  'chrome.title': 'Chrome',
  'chrome.note':
    'Use signed-in websites in Chrome on this computer. Manage site permissions separately.',
  'chrome.enable': 'Allow agents to use Chrome',
  'chrome.unsupported': 'Not available on this platform.',
  'chrome.browsers.darwin': 'Supports Google Chrome.',
  'chrome.browsers.win32': 'Supports Google Chrome. Edge and other browsers are not supported yet.',
  'chrome.browsers.linux': 'Supports Google Chrome, and Chromium when it is installed.',
  'chrome.checking': 'Checking extension connection…',
  'chrome.unprepared': 'Chrome connection is not set up',
  'chrome.disconnected': 'Waiting for the extension to connect',
  'chrome.waitingHelp':
    'Keep Chrome open. If the extension is already installed, check that Litch Browser is enabled on the extensions page. This status updates automatically.',
  'chrome.extensionOutdated':
    'The extension is too old for this version of Litch. Reload it on the extensions page.',
  'chrome.extensionOutdatedStore':
    'The extension is too old for this version of Litch. Click Update on the extensions page or wait for Chrome to update it.',
  'chrome.litchOutdated': 'The extension is newer than this Litch supports. Update Litch.',
  'chrome.reloadAvailable':
    'Version {version} is in the extension folder. Reload the extension to update.',
  'chrome.connected': 'Extension connected',
  'chrome.prepare': 'Prepare extension',
  'chrome.extensions': 'Open extensions',
  'chrome.store': 'Open in Chrome Web Store',
  'chrome.storeHeading': 'Install Litch Browser',
  'chrome.storeInstallAction': 'Install from Chrome Web Store',
  'chrome.storeInstall':
    'Add Litch Browser in Chrome when the store opens. It connects automatically after installation; no refresh is needed here.',
  'chrome.unpacked': 'Alternative: manual installation',
  'chrome.manualPrepare':
    'If the store is unavailable, prepare the local extension and load it using Developer mode.',
  'chrome.directory': 'Open extension folder',
  'chrome.stop': 'Stop all Chrome control',
  'chrome.install':
    'On the Chrome extensions page, enable Developer mode, choose Load unpacked, and select the folder below. Reload the extension after updating Litch.',
  'chrome.version': 'Folder version {version}',
  'chrome.remote': 'Remote devices',
  'chrome.remoteNote':
    'Selected devices may request control of Chrome on this computer. Chrome site permissions still apply.',
  'chrome.signIn': 'Sign in with Chrome',
  'chrome.signInNote':
    'Complete sign-in in Chrome. The agent cannot read or operate this tab while you sign in. Returning control reloads the page.',
  'chrome.signInDone': 'Sign-in complete',
  'chrome.approve': 'Allow access to a Chrome website',
} as const
