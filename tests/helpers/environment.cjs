'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Operations a restricted execution environment, such as a sandboxed agent shell, can deny to
// every process it starts. Each probe runs once per test process. denied(name) returns false when
// the operation works, and otherwise the skip reason naming the denial. A probe that fails for
// any other reason returns false, so the test runs and reports its own failure.
const PROBES = {
  loopback: {
    command: [process.execPath, '-e', "require('node:net').createServer().on('error',e=>{process.stderr.write(e.code);process.exit(1)}).listen(0,'127.0.0.1',function(){this.close()})"],
    denial: /^EPERM$/,
    reason: 'This environment denies loopback listening sockets (listen EPERM); run the suite outside the sandbox.',
  },
  privateTmp: {
    command: [process.execPath, '-e', "const fs=require('node:fs');try{fs.rmdirSync(fs.mkdtempSync('/private/tmp/maclauncher-probe-'))}catch(e){process.stderr.write(e.code);process.exit(1)}"],
    denial: /^EPERM$/,
    reason: 'This environment denies writing to /private/tmp outside its own temporary directory (EPERM); run the suite outside the sandbox.',
  },
  userCaches: {
    command: [process.execPath, '-e', "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const d=path.join(os.homedir(),'Library/Caches/maclauncher');try{fs.mkdirSync(d,{recursive:true});fs.rmSync(fs.mkdtempSync(path.join(d,'.probe-')),{recursive:true})}catch(e){process.stderr.write(e.code);process.exit(1)}"],
    denial: /^EPERM$/,
    reason: 'This environment denies writing to ~/Library/Caches/maclauncher (EPERM); run the suite outside the sandbox.',
  },
  sysctl: {
    command: ['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'],
    denial: /Operation not permitted/,
    reason: 'This environment denies sysctl queries such as kern.bootsessionuuid and sysctl.proc_translated (EPERM); run the suite outside the sandbox.',
  },
  atomicWrite: {
    command: () => {
      const file = path.join(os.tmpdir(), 'maclauncher-atomic-' + process.pid + '-' + Date.now());
      return ['/usr/bin/osascript', '-l', 'JavaScript', '-e', 'ObjC.import("Foundation"); const ok = $("x").writeToFileAtomicallyEncodingError(' +
        JSON.stringify(file) + ', true, 4, null); $.NSFileManager.defaultManager.removeItemAtPathError(' + JSON.stringify(file) + ', null); if (!ok) throw new Error("atomic write denied"); "true"'];
    },
    denial: /atomic write denied/,
    reason: 'This environment denies Cocoa atomic file replacement in its temporary directory; run the suite outside the sandbox.',
  },
  ps: {
    command: ['/bin/ps', '-o', 'stat=', '-p', String(process.pid)],
    spawnDenied: true,
    reason: 'This environment denies running /bin/ps (spawn EPERM), which process-exit detection uses; run the suite outside the sandbox.',
  },
  metal: {
    command: ['/usr/bin/osascript', '-l', 'JavaScript', '-e', 'ObjC.import("Metal"); if ($.MTLCreateSystemDefaultDevice().isNil()) throw new Error("no Metal device"); "ok"'],
    denial: /no Metal device/,
    reason: 'This environment gives its processes no Metal device (MTLCreateSystemDefaultDevice returns nil); run the suite outside the sandbox.',
  },
  diskImage: {
    command: () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-dmg-probe-'));
      fs.mkdirSync(path.join(directory, 'volume'));
      return ['/bin/sh', '-c', '/usr/bin/hdiutil create -srcfolder "$1/volume" -format UDRO -ov "$1/probe.dmg"; status=$?; rm -rf "$1"; exit $status', 'probe', directory];
    },
    denial: /Device not configured/,
    reason: 'This environment denies creating disk images (hdiutil create: Device not configured); run the suite outside the sandbox.',
  },
  seatbelt: {
    command: ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
    denial: /sandbox_apply: Operation not permitted/,
    reason: 'This environment denies applying a nested macOS sandbox profile (sandbox_apply EPERM); run the suite outside the sandbox.',
  },
};
const results = new Map();

function denied(name) {
  const probe = PROBES[name];
  if (!probe) throw new Error('Unknown environment probe: ' + name);
  if (process.platform !== 'darwin' && ['seatbelt', 'atomicWrite', 'sysctl', 'userCaches', 'metal', 'diskImage', 'ps'].includes(name)) return false;
  if (!results.has(name)) {
    const [command, ...args] = typeof probe.command === 'function' ? probe.command() : probe.command;
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
    const deniedNow = probe.spawnDenied ? result.error?.code === 'EPERM' : result.status !== 0 && probe.denial.test(String(result.stderr || '').trim());
    results.set(name, deniedNow ? probe.reason : false);
  }
  return results.get(name);
}

module.exports = { denied };
