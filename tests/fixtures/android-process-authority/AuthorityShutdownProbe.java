package maclauncher.android;

import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicInteger;

/** Original Runtime shutdown hooks create threads after the real authority EOF. */
public final class AuthorityShutdownProbe {
 public static void main(String[] args)throws Exception{
  System.setProperty("klepton.bridge","/system/lib64/libart-platform.so");
  System.load("/system/lib64/libart-authority.so");System.load("/system/lib64/libart-platform.so");
  android.content.res.AssetManager.createSystemAssetsInZygoteLocked(false,"/system/framework/framework-res.apk");
  android.os.Looper.prepareMainLooper();
  var browserType=Class.forName("maclauncher.android.ArtWebKit");var constructor=browserType.getDeclaredConstructor(String.class,String.class);constructor.setAccessible(true);
  AutoCloseable browser=(AutoCloseable)constructor.newInstance(args[0],"shutdown-fixture");
  Runtime.getRuntime().addShutdownHook(new Thread(()->{
   AtomicInteger completed=new AtomicInteger();
   Thread child=new Thread(completed::incrementAndGet,"shutdown child");child.start();
   try{child.join();}catch(InterruptedException failure){throw new AssertionError(failure);}
   if(completed.get()!=1)throw new AssertionError("Shutdown child did not complete");
   System.out.println("PASS original ART shutdown hook and child after authority retirement");
  },"original shutdown hook"));
  try(var authority=ProcessAuthority.read(5,"fixture.shutdown","fixture.shutdown")){
   Method receive=ProcessAuthority.class.getDeclaredMethod("receiveNative",int.class);receive.setAccessible(true);
   System.out.println("READY authority");
   if(receive.invoke(null,5)!=null)throw new AssertionError("Expected original authority EOF");
  }
  System.out.println("RETIRED authority");
  Thread before=new Thread(()->{},"before original helper");before.start();before.join();System.out.println("JOINED before original helper");
  var helper=new ProcessBuilder("/system/bin/idmap2","--help").redirectErrorStream(true).start();
  byte[] output=helper.getInputStream().readAllBytes();int status=helper.waitFor();
  System.out.println("IDMAP exit="+status);System.out.write(output);
  Thread after=new Thread(()->{},"after original helper");System.out.println("START after original helper");after.start();System.out.println("STARTED after original helper");after.join();System.out.println("JOINED after original helper");
  // Original idmap2 has no global --help option: its unchanged Main reports
  // command-not-found and usage with EXIT_FAILURE. Distinguish that actual
  // execution from libcore childProcess's _exit(-1) before exec.
  String text=new String(output,java.nio.charset.StandardCharsets.UTF_8);
  if(status!=1||!text.contains("--help: command not found")||!text.contains("usage: idmap2 ["))
   throw new AssertionError("Original idmap2 did not execute: exit="+status);
  browser.close();
  System.out.println("RETIRED browser");System.exit(0);
 }
}
