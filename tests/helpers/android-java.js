const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Source fixtures compile the owned adapters over the same full framework used
// by Host. Keep fixture classes first, including intentional test replacements.
// A built Android runtime comes from KLEPTON_NATIVE_RUNTIME or the declared
// default directory. The runtime is a managed package, so a plain checkout has
// neither; tests that need one skip through this lookup.
function runtimeRoot() {
  let root = process.env.KLEPTON_NATIVE_RUNTIME;
  if (!root) {
    const declaration = path.resolve(__dirname, '../../src/modules/android/managed-packages.json');
    if (fs.existsSync(declaration)) {
      const entry = JSON.parse(fs.readFileSync(declaration, 'utf8'))[0];
      root = path.resolve(__dirname, '../../src/resources/native-runtimes', entry.directoryRelative);
    }
  }
  return root && fs.existsSync(path.resolve(root, 'android-framework.jar')) ? path.resolve(root) : null;
}

// JDK 21 from JAVA_HOME or the macOS registry; null when neither names one.
function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const result = childProcess.spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function frameworkArguments(executable, args) {
  if (!['java', 'javac'].includes(path.basename(executable)) || args.includes('-jar')) return args;
  const root = runtimeRoot();
  if (!root) throw new Error('Android Java fixtures require the framework; set KLEPTON_NATIVE_RUNTIME to a built runtime.');
  const framework = path.resolve(root, 'android-framework.jar');
  const result = [...args];
  if(path.basename(executable)==='javac'&&result.some(value=>/\/java\/maclauncher\/android\/(?:RuntimeBootstrap|framework\/(?:HostApplication|HostSystemServices))\.java$/.test(value))){
    const timing=path.resolve(__dirname,'../../src/modules/android/native/java/maclauncher/android/framework/HostStartupTiming.java');
    if(!result.includes(timing))result.push(timing);
  }
  if(path.basename(executable)==='java')result.unshift(...require('../../src/modules/android/jvm-options').frameworkJvmOptions,'-Dandroid.test.runtime='+path.dirname(framework));
  if(path.basename(executable)==='javac'&&result.some(value=>value.endsWith('/java/maclauncher/android/framework/FrameworkResources.java')))
    result.push(path.resolve(__dirname,'../fixtures/android-framework-services/NativeResourceSupport.java'));
  const index = result.findIndex(value => ['-cp', '-classpath', '--class-path'].includes(value));
  if (index < 0) result.unshift('-classpath', framework);
  else {
    const entries = result[index + 1].split(path.delimiter);
    if (!entries.some(value => path.resolve(value) === framework)) entries.push(framework);
    result[index + 1] = entries.join(path.delimiter);
  }
  return result;
}

// Android process and thread IDs are leases in the supervisor's private
// namespace, which every production launch supplies. A fixture JVM without
// one receives its own private namespace for the lifetime of the call.
function processNamespace(directory) {
  const ids = path.join(directory, 'ids');
  fs.mkdirSync(ids, { mode: 0o700 });
  return { KL_ANDROID_ID_DIRECTORY: fs.realpathSync(ids) };
}

function spawnSync(executable, args, options = {}) {
  const env = options.env || process.env;
  if (path.basename(executable) !== 'java' || args.includes('-jar') || env.KL_ANDROID_ID_DIRECTORY)
    return childProcess.spawnSync(executable, frameworkArguments(executable, args), options);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-process-ids-'));
  try {
    return childProcess.spawnSync(executable, frameworkArguments(executable, args),
      { ...options, env: { ...env, ...processNamespace(directory) } });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// A test declares the runtime it exercises, as installation declares a managed
// version, so profile owners resolve that manifest instead of the bundled record.
function runtimeIdentity(root) {
  const bytes = fs.readFileSync(path.join(root, 'runtime.json')), { version, minimumMacOS } = JSON.parse(bytes);
  const manifestSha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  return require('../../src/modules/android/runtime').resolve({ root }, { version, minimumMacOS, manifestSha256 }).runtimeIdentity;
}

// AOSP HostRuntime's JNI_OnLoad reads its seven configuration properties
// through System.getProperty without an exception check, and -Xcheck:jni
// reports each read. Every other native-method warning or error remains.
const hostRuntimeWarning = 'WARNING in native method: JNI call made without checking exceptions when required to from CallStaticObjectMethodV';
function nativeMethodDiagnostics(output) {
  const lines = output.split('\n').filter(line => /^(?:WARNING|FATAL ERROR) in native method/.test(line));
  const startup = lines.filter(line => line === hostRuntimeWarning).length;
  return startup === 7 ? lines.filter(line => line !== hostRuntimeWarning) : lines;
}

module.exports = { frameworkArguments, javaHome, nativeMethodDiagnostics, processNamespace, runtimeIdentity, runtimeRoot, spawnSync };
