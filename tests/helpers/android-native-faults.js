const fs=require('node:fs');
const path=require('node:path');
const source=path.resolve(__dirname,'../../src/modules/android/native');
const fixtures=path.resolve(__dirname,'../fixtures/android-native');

// Fault instrumentation exists only in temporary test translation units. The
// complete production implementation remains the input, with no runtime hook.
function replace(text,anchor,value){
 if(text.split(anchor).length!==2)throw new Error('Native fixture insertion point changed: '+anchor);
 return text.replace(anchor,value);
}
function inventorySource(){
 let code=fs.readFileSync(path.join(source,'native-methods.c'),'utf8');
 code=replace(code,'static void fail(',fs.readFileSync(path.join(fixtures,'native-inventory-support.inc'),'utf8')+'\nstatic void fail(');
 code=replace(code,'if(memory)(*ti)->Deallocate(ti,memory);','if(memory){atomic_fetch_sub(&outstanding,1);(*ti)->Deallocate(ti,memory);}');
 code=replace(code,'(*ti)->DisposeEnvironment(ti);','if((*ti)->DisposeEnvironment(ti)==JVMTI_ERROR_NONE)atomic_fetch_sub(&environments,1);');
 code=replace(code,'    jmethodID *methods=NULL;', '    atomic_fetch_add(&environments,1);\n    jmethodID *methods=NULL;');
 code=replace(code,'error=(*ti)->GetClassMethods(ti,target,&count,&methods);','error=(*ti)->GetClassMethods(ti,target,&count,&methods);track(methods);');
 code=replace(code,'    if(count<0||count>65535)', '    if(injected(env,1)){finish(ti,methods);return NULL;}\n    if(count<0||count>65535)');
 code=replace(code,'error=(*ti)->GetMethodName(ti,methods[i],&name,&signature,NULL);','error=(*ti)->GetMethodName(ti,methods[i],&name,&signature,NULL);track(name);track(signature);');
 code=replace(code,'        if((*env)->PushLocalFrame(env,4)<0)', '        if(injected(env,2)){release(ti,name);release(ti,signature);goto failure;}\n        if((*env)->PushLocalFrame(env,4)<0)');
 code=replace(code,'if(values[0])values[1]','if(values[0]&&!injected(env,3))values[1]');
 return code+'\n'+fs.readFileSync(path.join(fixtures,'native-inventory-pending.inc'),'utf8');
}
function registrationSource(){
 let code=fs.readFileSync(path.join(source,'loader-native-registration.c'),'utf8');
 code=replace(code,'static pthread_mutex_t registration_mutex=', 'static unsigned test_live_environments,test_fail_stage;\nstatic pthread_mutex_t registration_mutex=');
 code=replace(code,'int klj_registration_install(JNIEnv *env){','int klj_registration_install(JNIEnv *env){\n    const unsigned test_fault_base=0;');
 code=replace(code,'int klj_registration_prepare(JNIEnv *env,void *runtime,void *image){','int klj_registration_prepare(JNIEnv *env,void *runtime,void *image){\n    const unsigned test_fault_base=3;');
 const twice=(anchor,value)=>{if(code.split(anchor).length!==3)throw new Error('Both registration stages must be instrumented: '+anchor);code=code.replaceAll(anchor,value);};
 twice('    if(okay)okay=(*ti)->GetJNIFunctionTable(ti,&table)==JVMTI_ERROR_NONE;', '    if(okay)okay=test_fail_stage!=test_fault_base+1&&(*ti)->GetJNIFunctionTable(ti,&table)==JVMTI_ERROR_NONE;\n    if(okay)okay=test_fail_stage!=test_fault_base+2;');
 twice('(*ti)->SetJNIFunctionTable(ti,table)==JVMTI_ERROR_NONE', '(test_fail_stage!=test_fault_base+3&&(*ti)->SetJNIFunctionTable(ti,table)==JVMTI_ERROR_NONE)');
 return code;
}
module.exports={inventorySource,registrationSource};
