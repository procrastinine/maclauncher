import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=import.meta.dirname;
const payload=await require('../runtime').resolveForLaunch();
const jdk=process.env.MACLAUNCHER_ANDROID_OVERLAY_JDK||'/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home';
const source=path.join(root,'java/maclauncher/android/framework/HostTextInput.java');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-text-input-build-'));
try{
 const classes=path.join(temporary,'classes');fs.mkdirSync(classes);
 execFileSync(path.join(jdk,'bin/javac'),['--release','21','-proc:none','-encoding','UTF-8','-cp',
  [path.join(payload.root,'android-host.jar'),path.join(payload.root,'android-framework.jar')].join(path.delimiter),'-d',classes,source],{stdio:'inherit'});
 fs.mkdirSync(path.join(classes,'META-INF'));fs.copyFileSync(path.join(root,'LICENSE'),path.join(classes,'META-INF/LICENSE'));
 const artifact=path.resolve(root,'../resources/text-input.jar');
 execFileSync(path.join(jdk,'bin/jar'),['--create','--file',artifact,'--date=2026-10-21T00:00:00Z','-C',classes,'.'],{stdio:'inherit'});
 const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
 fs.writeFileSync(path.resolve(root,'../resources/text-input.json'),JSON.stringify({schema:1,sourceSha256:digest(fs.readFileSync(source)),sha256:digest(fs.readFileSync(artifact))},null,2)+'\n');
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
