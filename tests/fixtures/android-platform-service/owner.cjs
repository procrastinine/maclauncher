const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { run } = require('../../../src/modules/android/platform-services/owner');
const { connectAuthority } = require('../../../src/modules/android/platform-services/jvm');
run(JSON.parse(process.argv[2]), { startService: async (config, storage, lockFd) => {
  if(config.failBeforeAdapterReturn)throw Object.assign(Error('PRIVATE_BOOTSTRAP_PATH'),{
    code:'EBUSY',platformStartupStage:'prepare-account-storage'
  });
  const adapter = await connectAuthority(spawn(process.execPath, [path.join(__dirname, 'service.cjs'), storage.root, config.enrollmentFailureType||''],
    { stdio: ['ignore', 'ignore', 'pipe', 'ignore', lockFd, 'pipe'] }));
  if(config.enrollmentGate){
    const enroll=adapter.enroll;let first=true;
    adapter.enroll=async(...arguments_)=>{
      if(first){
        first=false;fs.writeFileSync(config.enrollmentGate+'.waiting','');
        while(!fs.existsSync(config.enrollmentGate))await new Promise(resolve=>setTimeout(resolve,5));
      }
      return enroll(...arguments_);
    };
  }
  adapter.diagnostics = adapter.child.stderr;
  if (config.role === 'accounts') {
    delete adapter.diagnostics;
    adapter.child.stderr.resume();
    const close=adapter.close;
    adapter.close=async()=>{
      close();
      await new Promise(resolve=>setTimeout(resolve,850));
      fs.appendFileSync(path.join(storage.root,'events.jsonl'),JSON.stringify({op:'adapter-retired'})+'\n');
    };
    adapter.identity = { ...adapter.identity, packageName: 'android', processName: 'android.accounts', uid: 1000, securityContext: 'u:r:system_server:s0' };
    adapter.request = async (command, payload, context) => {
      context.signal.throwIfAborted();
      fs.appendFileSync(path.join(storage.root,'events.jsonl'),JSON.stringify({op:'request',command,networkAllowed:context.networkAllowed,interactive:context.interactive})+'\n');
      return {accounts:[],completed:true};
    };
    if (config.failStartup || config.failStartupJavaScript) {
      const cause = config.failStartupJavaScript ? TypeError('PRIVATE_PROVIDER_MESSAGE oauth_token=PRIVATE_TOKEN') : Object.assign(Error('Original account startup failure'), {
        code: 'ACCOUNT_PROVIDER_ERROR', providerFailureType: 'java.io.IOException',
        providerFailureSite: 'fixture.Packages.verify:42'
      });
      let failure;
      adapter.startupFailure = () => failure;
      adapter.startupStage = () => 'initialize-services';
      adapter.ready = adapter.ready.then(async () => {
        failure = cause;
        await adapter.close();
        throw cause;
      });
      adapter.ready.catch(() => {});
    }
  }
  return adapter;
}
}).catch(error => { console.error(error); process.exitCode = 1; });
