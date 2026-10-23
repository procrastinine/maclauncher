import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

// Included adapter compilation is a developer operation, never game setup.
const root=import.meta.dirname,jdk=process.env.MACLAUNCHER_POLICY_JDK||'/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arguments-build-'));
try{
 const classes=path.join(temporary,'classes');fs.mkdirSync(classes);
 execFileSync(path.join(jdk,'bin/javac'),['-source','17','-target','17','--add-exports','java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED','-d',classes,
  ...['ArgumentsAgent.java','ArgumentsBridge.java'].map(file=>path.join(root,'java/com/maclauncher/android/arguments',file))],{stdio:'inherit'});
 const manifest=path.join(temporary,'MANIFEST.MF');fs.writeFileSync(manifest,'Manifest-Version: 1.0\nPremain-Class: com.maclauncher.android.arguments.ArgumentsAgent\n\n');
 const output=path.resolve(root,'../resources');fs.mkdirSync(output,{recursive:true});
 execFileSync(path.join(jdk,'bin/jar'),['--create','--file',path.join(output,'launch-arguments.jar'),'--manifest',manifest,'--date=2026-10-21T00:00:00Z','-C',classes,'.'],{stdio:'inherit'});
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
