export const enChrome = {
  'chrome.instance': 'Allow access to this Chrome instance',
  'chrome.instanceNote':
    'Allow the agent to list tab titles and URLs in this Chrome instance. Page content still requires origin approval.',
  'chrome.title': 'Chrome',
  'chrome.note': 'Use signed-in websites in Chrome on this Mac. Each origin requires approval.',
  'chrome.enable': 'Allow agents to use Chrome',
  'chrome.unsupported': 'Currently available on macOS only.',
  'chrome.unprepared': 'Extension not prepared',
  'chrome.disconnected': 'Extension disconnected. Load or reload it to connect.',
  'chrome.mismatch': 'Extension version mismatch. Reload it on the extensions page.',
  'chrome.connected': 'Extension connected',
  'chrome.prepare': 'Prepare extension',
  'chrome.extensions': 'Open extensions',
  'chrome.directory': 'Open extension folder',
  'chrome.stop': 'Stop all Chrome control',
  'chrome.install':
    'On the Chrome extensions page, enable Developer mode, choose Load unpacked, and select the folder below. Reload the extension after updating Litch.',
  'chrome.version': 'Required version {version}',
  'chrome.remote': 'Remote devices',
  'chrome.remoteNote':
    'Selected devices may request control of Chrome on this Mac. Each origin still requires approval.',
  'chrome.signIn': 'Sign in with Chrome',
  'chrome.signInNote':
    'Complete sign-in in Chrome. The agent cannot read or operate this tab while you sign in. Returning control reloads the page.',
  'chrome.signInDone': 'Sign-in complete',
  'chrome.approve': 'Allow access to a Chrome website',
} as const
