import android.os.StrictMode;
import android.os.SystemClock;
import android.system.*;
import maclauncher.android.framework.*;
import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
/** Original Android OS API/state over real Mach clocks and private POSIX files. */
public final class NativeOsProbe {
 static void check(boolean value,String name){if(!value)throw new AssertionError(name);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),root=Path.of(args[1]);Files.createDirectories(root.resolve("files"));Files.createDirectories(root.resolve("cache"));
  HostFilesystem.configure(runtime,root,root.resolve("files"),root.resolve("cache"),"owned.os");
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());maclauncher.android.framework.HostProcessIdentity.initializeIds();
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  dalvik.system.VMRuntime.getRuntime().updateProcessState(0);dalvik.system.VMRuntime.getRuntime().updateProcessState(1);
  dalvik.system.VMRuntime.getRuntime().notifyStartupCompleted();dalvik.system.VMRuntime.getRuntime().preloadDexCaches();
  dalvik.system.VMRuntime.bootCompleted();dalvik.system.VMRuntime.registerSensitiveThread();dalvik.system.VMRuntime.resetJitCounters();
  dalvik.system.VMRuntime.registerAppInfo("owned.os",root.resolve("profile").toString(),root.resolve("reference").toString(),new String[]{"classes.dex"},dalvik.system.VMRuntime.CODE_PATH_TYPE_PRIMARY_APK);
  check(android.os.Process.myPid()>0&&android.os.Process.myPid()==Os.getpid(),"leased Android PID");check(android.os.Process.myUid()==Os.getuid(),"actual UID");check(android.os.Process.is64Bit(),"actual word size");
  android.os.Process.setArgV0("owned.os");check(android.os.Process.myProcessName().equals("owned.os"),"original process name state");
  check(android.os.Process.myTid()>0,"actual TID");int p=android.os.Process.getThreadPriority(0);android.os.Process.setThreadPriority(10);check(android.os.Process.getThreadPriority(0)==10,"real background QoS");android.os.Process.setThreadPriority(p);
  // AOSP enforces setCanSelfBackground only under #if defined(__linux__); the host build accepts both calls.
  android.os.Process.setCanSelfBackground(false);android.os.Process.setCanSelfBackground(true);
  check(android.os.Process.getThreadPriority(0)==p,"background policy preserves existing QoS");
  var started=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);var workerTid=new java.util.concurrent.atomic.AtomicInteger();
  Thread worker=new Thread(()->{workerTid.set(android.os.Process.myTid());started.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}},"owned-priority");
  worker.start();check(started.await(5,java.util.concurrent.TimeUnit.SECONDS),"priority worker started");
  try{for(int value:new int[]{10,5,0,-4,-16}){android.os.Process.setThreadPriority(workerTid.get(),value);check(android.os.Process.getThreadPriority(workerTid.get())==value,"original cross-thread priority reaches actual kernel");}check(android.os.Process.getThreadScheduler(workerTid.get())==0,"owned worker scheduler");}
  finally{release.countDown();worker.join(5000);}
  check(!worker.isAlive(),"priority worker cleaned up");
  long before=System.nanoTime(),now=SystemClock.uptimeNanos(),after=System.nanoTime();check(now>=before&&now<=after,"same monotonic domain");check(SystemClock.elapsedRealtimeNanos()>=now,"continuous clock");
  long cpu=SystemClock.currentThreadTimeMicro();for(int i=0;i<100000;i++)Math.sqrt(i);check(SystemClock.currentThreadTimeMicro()>=cpu,"thread CPU");long wait=SystemClock.uptimeMillis();SystemClock.sleep(10);check(SystemClock.uptimeMillis()-wait>=10,"original sleep deadline");
  String dir="/data/files/os-probe";try{Os.mkdir(dir,0700);}catch(ErrnoException e){if(e.errno!=OsConstants.EEXIST)throw e;}
  String file=dir+"/bytes";FileDescriptor fd=Os.open(file,OsConstants.O_RDWR|OsConstants.O_CREAT|OsConstants.O_TRUNC,0600);
  try{
   byte[] bytes={1,2,3,4};check(Os.write(fd,bytes,0,4)==4,"array write");check(Os.lseek(fd,0,OsConstants.SEEK_SET)==0,"seek");ByteBuffer direct=ByteBuffer.allocateDirect(4);check(Os.read(fd,direct)==4&&direct.get(2)==3,"direct read and position");
   check(Os.pwrite(fd,new byte[]{8},0,1,2)==1,"positioned write");byte[] data=new byte[4];check(Os.pread(fd,data,0,4,0)==4&&Arrays.equals(data,new byte[]{1,2,8,4}),"positioned read");
   Os.fchmod(fd,0640);check((Os.fstat(fd).st_mode&0777)==0640&&Os.stat(file).st_size==4,"real stat/chmod");Os.fsync(fd);Os.ftruncate(fd,3);check(Os.fstat(fd).st_size==3,"truncate");
   FileDescriptor copy=Os.dup(fd);Os.close(copy);check(!copy.valid()&&fd.valid(),"descriptor ownership");
   check(Os.fstatvfs(fd).f_bsize>0,"actual filesystem blocks");
  }finally{Os.close(fd);}check(!fd.valid(),"close invalidates descriptor");
  Os.rename(file,file+"2");Os.link(file+"2",file+"3");Os.symlink("bytes2",file+"link");check(Os.readlink(file+"link").equals("bytes2"),"relative symlink retained");check(Os.lstat(file+"link").st_size==6,"lstat link");
  FileDescriptor[] pipe=Os.pipe2(OsConstants.O_CLOEXEC|OsConstants.O_NONBLOCK);try{Os.write(pipe[1],new byte[]{9},0,1);StructPollfd f=new StructPollfd();f.fd=pipe[0];f.events=(short)OsConstants.POLLIN;check(Os.poll(new StructPollfd[]{f},100)==1&&(f.revents&OsConstants.POLLIN)!=0,"real descriptor readiness");byte[] b=new byte[1];check(Os.read(pipe[0],b,0,1)==1&&b[0]==9,"pipe transfer");}finally{Os.close(pipe[0]);Os.close(pipe[1]);}
  try{Os.open(dir+"/absent",OsConstants.O_RDONLY,0);throw new AssertionError("missing file accepted");}catch(ErrnoException expected){check(expected.errno==OsConstants.ENOENT,"Linux errno");}
  check(Os.sysconf(OsConstants._SC_PAGESIZE)==Os.statvfs(dir).f_bsize||Os.sysconf(OsConstants._SC_PAGESIZE)>0,"actual page size");
  check(!StrictMode.vmImplicitDirectBootEnabled(),"original VM policy default");
  StrictMode.VmPolicy originalVmPolicy=StrictMode.getVmPolicy();
  StrictMode.VmPolicy observedVmPolicy=new StrictMode.VmPolicy.Builder().detectNonSdkApiUsage().build();
  StrictMode.setVmPolicy(observedVmPolicy);check(StrictMode.getVmPolicy()==observedVmPolicy,"original VM policy transition");
  StrictMode.setVmPolicy(StrictMode.VmPolicy.LAX);check(StrictMode.getVmPolicy()==StrictMode.VmPolicy.LAX,"VM policy reset");
  StrictMode.setVmPolicy(originalVmPolicy);
  StrictMode.setThreadPolicy(new StrictMode.ThreadPolicy.Builder().detectNetwork().penaltyDeathOnNetwork().build());boolean denied=false;try{HostStrictMode.hostNoteNetwork();}catch(android.os.NetworkOnMainThreadException expected){denied=true;}check(denied,"original synchronous network policy");
  HostStrictMode.hostClearThreadPolicy();HostStrictMode.hostNoteNetwork();check(StrictMode.getThreadPolicyMask()==0,"original thread policy cleanup");
  for(String n:new String[]{"bytes2","bytes3","byteslink"})Os.unlink(dir+"/"+n);Os.remove(dir);
  System.out.println("PASS raw Process/SystemClock/StrictMode, private POSIX descriptors, array/direct I/O, metadata, links, poll and Linux errors");
 }
}
