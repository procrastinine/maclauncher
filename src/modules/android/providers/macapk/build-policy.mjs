import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Developer-only compilation of the small owned policy adapter. Downloads and
// ordinary launches consume its included JAR and require no compiler.
const root=path.dirname(fileURLToPath(import.meta.url));
const jdk=process.env.MACLAUNCHER_POLICY_JDK||'/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home';
const work=fs.mkdtempSync(path.join(os.tmpdir(),'macapk-policy-build-'));
try{
 const classes=path.join(work,'classes');fs.mkdirSync(classes);
 execFileSync(path.join(jdk,'bin/javac'),['-source','17','-target','17','--add-exports','java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED','-d',classes,
  ...['PrivacyAgent.java','PrivacyBridge.java','PrivacyProbe.java','AuthBridge.java','JsonRpc.java','IconPreparation.java','AccountControl.java','Capabilities.java'].map(file=>path.join(root,'java',file))],{stdio:'inherit'});
 const manifest=path.join(work,'MANIFEST.MF');fs.writeFileSync(manifest,'Manifest-Version: 1.0\nPremain-Class: com.maclauncher.android.macapk.PrivacyAgent\n\n');
 const resources=path.join(root,'resources');fs.mkdirSync(resources,{recursive:true});
 execFileSync(path.join(jdk,'bin/jar'),['--create','--file',path.join(resources,'privacy.jar'),'--manifest',manifest,'--date=2026-10-19T00:00:00Z','-C',classes,'.'],{stdio:'inherit'});
}finally{fs.rmSync(work,{recursive:true,force:true});}
