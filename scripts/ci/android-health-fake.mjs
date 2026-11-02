// 执行器编排测试共用的 ADB 替身；业务测试仍使用真实执行器与子进程。
export const fakeHealthAdb = `
function healthAdb(args) {
  const fs = require('node:fs');
  const started = () => process.env.EVENTS && fs.readFileSync(process.env.EVENTS, 'utf8').includes('"kind":"maestro"');
  const anr = () => {
    const mode = process.env.ANR_MODE;
    if (!mode || mode === 'monitor-exit' || (mode !== 'precheck-system' && !started())) return '';
    if (mode === 'mixed') return '1700000001.000001 100 100 I am_anr: [0,123,com.google.android.apps.nexuslauncher,123,timeout]\\n1700000001.000002 100 100 I am_anr: [0,456,dev.litch.app,123,timeout]';
    const name = mode === 'litch-child' ? 'dev.litch.app:worker' : mode.startsWith('litch') ? 'dev.litch.app' : mode === 'precheck-system' ? 'com.google.android.apps.nexuslauncher' : 'unrecognized';
    return '1700000001.000001 100 100 I am_anr: [0,123,' + name + ',123,Input dispatching timed out]';
  };
  if (args.includes('get-state')) {
    console.log(process.env.MODE === 'recovery-offline' && started() ? 'offline' : 'device');
  } else if (args.includes('/proc/sys/kernel/random/boot_id')) console.log('test-boot-id');
  else if (args.includes('getprop')) console.log('1');
  else if (args.includes('resolve-activity')) console.log('com.android.launcher/.Home');
  else if (args.includes('window') && !args.includes('windows')) console.log(process.env.ANR_MODE === 'precheck-dialog' ? 'mCurrentFocus=Window{abc Application Not Responding: Unknown}' : 'mCurrentFocus=Window{abc u0 com.android.launcher/.Home}');
  else if (args.includes('logcat')) {
    const marker = process.env.ANR_MODE === 'monitor-exit' && started() ? '1700000002.000000 100 100 I marker: buffer-overwritten' : '1700000000.000000 100 100 I marker: ready';
    if (args.includes('-d')) console.log(marker + '\\n' + anr());
    else setInterval(() => {
      if (process.env.ANR_MODE === 'monitor-exit' && started()) process.exit(1);
      console.log(marker); const line = anr(); if (line) console.log(line);
    }, 10);
  } else return false;
  return true;
}
`
