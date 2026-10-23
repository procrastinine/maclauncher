import android.os.*;
import maclauncher.android.framework.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Headless physical-input completion over the original Android queue. */
public final class TextInputPasteQueueProbe {
 public static void main(String[] args)throws Exception {
  Path runtime=Path.of(args[0]),root=Path.of(args[1]);Files.createDirectories(root.resolve("files"));Files.createDirectories(root.resolve("cache"));
  HostFilesystem.configure(runtime,root,root.resolve("files"),root.resolve("cache"),"owned.paste.queue");
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  HostProcessIdentity.initializeIds();JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  HostContext.hostPackage("owned.paste.queue","1",1);
  Looper loop=HostLooper.main();
  var factory=HostTextInput.class.getDeclaredMethod("clipboardHandler");factory.setAccessible(true);
  Handler paste=(Handler)factory.invoke(null),ordinary=new Handler(loop);List<String> delivered=new ArrayList<>();
  int barrier=loop.getQueue().postSyncBarrier();
  try {
   ordinary.post(()->delivered.add("ordinary"));
   CompletableFuture<Boolean> reply=new CompletableFuture<>();reply.thenAccept(value->paste.post(()->{if(value)delivered.add("paste");}));
   Thread transport=new Thread(()->reply.complete(true));transport.start();transport.join();
   HostLooper.pump(loop);
   if(!delivered.equals(List.of("paste")))throw new AssertionError("Physical paste completion must run while a traversal barrier blocks ordinary messages");
  }finally{loop.getQueue().removeSyncBarrier(barrier);}
  HostLooper.pump(loop);if(!delivered.equals(List.of("paste","ordinary")))throw new AssertionError("Barrier release must preserve original callback order");
  HostLooper.close(loop);
  System.out.println("PASS physical paste completion crosses original traversal barrier; ordinary message remains ordered");
 }
}
