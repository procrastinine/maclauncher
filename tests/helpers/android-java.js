const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

// Source fixtures compile the owned adapters over the same full framework used
// by Host. Keep fixture classes first, including intentional test replacements.
function frameworkArguments(executable, args) {
  if (!['java', 'javac'].includes(path.basename(executable)) || args.includes('-jar')) return args;
  let root = process.env.KLEPTON_NATIVE_RUNTIME;
  if (!root) {
    const declaration = path.resolve(__dirname, '../../src/modules/android/distribution-supplementals.json');
    if (fs.existsSync(declaration)) {
      const entry = JSON.parse(fs.readFileSync(declaration, 'utf8'))[0];
      root = path.resolve(__dirname, '../../src/resources/native-runtimes', entry.directoryRelative);
    }
  }
  if (!root) throw new Error('Set KLEPTON_NATIVE_RUNTIME to the built Android runtime containing android-framework.jar.');
  const framework = path.resolve(root, 'android-framework.jar');
  if (!fs.existsSync(framework))
    throw new Error('Android Java fixtures require the included framework; set KLEPTON_NATIVE_RUNTIME to a built runtime.');
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

function spawnSync(executable, args, options) {
  return childProcess.spawnSync(executable, frameworkArguments(executable, args), options);
}

module.exports = { frameworkArguments, spawnSync };
