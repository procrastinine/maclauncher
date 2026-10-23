import android.os.incremental.IncrementalManager;
import android.util.apk.*;
import android.content.pm.parsing.result.ParseTypeImpl;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.HostLooper;
import maclauncher.android.framework.HostMappedBuffer;
import android.system.*;
import java.io.*;import java.nio.file.*;import java.util.zip.*;
/** Complete original IncFS clients and APK signature fallbacks over ordinary files. */
public final class IncrementalFilesystemProbe {
 static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
 public static void main(String[] args)throws Exception{
  var loop=RuntimeFixture.initialize(args[0],args[1]);String overlay=System.getProperty("android.fixture.filesystem");if(overlay!=null)System.load(overlay);String process=System.getProperty("android.fixture.process");if(process!=null)System.load(process);Path apk=Path.of(args[1],"unsigned.apk");
  try(var output=new ZipOutputStream(Files.newOutputStream(apk))){output.putNextEntry(new ZipEntry("assets/value"));output.write(1);output.closeEntry();}
  try{
   check(!dalvik.system.VMDebug.isDebuggerConnected()&&!dalvik.system.VMDebug.isDebuggingEnabled()&&dalvik.system.VMDebug.lastDebuggerActivity()==-1,"no Android debugger transport");
   long cpu=dalvik.system.VMDebug.threadCpuTimeNanos();check(cpu>0&&dalvik.system.VMDebug.threadCpuTimeNanos()>=cpu,"actual JVM thread CPU clock");
   check(dalvik.system.VMDebug.getLoadedClassCount()>0&&Long.parseLong(dalvik.system.VMDebug.getRuntimeStat("art.gc.gc-count"))>=0,"actual JVM runtime counters");
   check(dalvik.system.VMDebug.getVmFeatureList().length==0&&dalvik.system.VMDebug.getMethodTracingMode()==0,"no advertised ART tracing");
   check(!IncrementalManager.isFeatureEnabled()&&!IncrementalManager.isAllowed()&&IncrementalManager.getVersion()==0,"ordinary filesystem has no IncFS mount");
   check(!IncrementalManager.isIncrementalPath(apk.toString()),"ordinary APK path");
   try(var input=new FileInputStream(apk.toFile())){check(!IncrementalManager.isIncrementalFileFd(input.getFD()),"ordinary actual file descriptor");}
   check(IncrementalManager.unsafeGetFileSignature(apk.toString())==null,"no kernel IncFS signature metadata");
   try{ApkSignatureSchemeV4Verifier.extractSignature(apk.toString());throw new AssertionError("missing sidecar accepted");}catch(SignatureNotFoundException expected){}
   check(ApkSignatureVerifier.verify(ParseTypeImpl.forDefaultParsing(),apk.toString(),1).isError(),"original verifier rejects unsigned APK");
   try(var file=new RandomAccessFile(Path.of(args[1],"mapped-file").toFile(),"rw")){
    long page=Os.sysconf(OsConstants._SC_PAGESIZE);file.setLength(page);file.write(13);
    long address=Os.mmap(0,page,OsConstants.PROT_READ|OsConstants.PROT_WRITE,OsConstants.MAP_SHARED,file.getFD(),0);
    try{
     var writable=HostMappedBuffer.create((int)page,address,file.getFD(),null,false);var readOnly=HostMappedBuffer.create((int)page,address,file.getFD(),null,true);
     check(writable.isDirect()&&readOnly.isReadOnly()&&readOnly.get(0)==13,"real shared read-only mapped bytes");
     writable.put(0,(byte)42);writable.force();file.seek(0);check(file.read()==42&&readOnly.get(0)==42,"mapped views share native address and force to file");
     try{readOnly.put(0,(byte)1);throw new AssertionError("read-only write allowed");}catch(java.nio.ReadOnlyBufferException expected){}
     byte[] resident=new byte[1];Os.mincore(address,page,resident);check(resident[0]==1,"native residency for actual host page");
    }finally{Os.munmap(address,page);}
   }
   if(args.length>2){var verified=ApkSignatureVerifier.verify(ParseTypeImpl.forDefaultParsing(),args[2],1);check(!verified.isError(),"original full APK verification: "+verified.getErrorMessage());check(verified.getResult().hasSignatures(),"verified signing certificates retained");}
   System.out.println("PASS original incremental filesystem observations and APK signature verification fallbacks");
  }finally{HostLooper.close(loop);}
 }
}
