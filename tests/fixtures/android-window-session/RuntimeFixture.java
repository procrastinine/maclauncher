package maclauncher.android.fixture;
import java.nio.file.*;
import android.os.Looper;
import maclauncher.android.framework.*;
/** Real full-framework bootstrap shared only by tests. No Android API doubles. */
public final class RuntimeFixture {
 public static Looper initialize(String runtimeArg,String dataArg,String... libraries)throws Exception{
  Path runtime=Path.of(runtimeArg).toRealPath(),data=Files.createDirectories(Path.of(dataArg)).toRealPath();
  Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
  HostFilesystem.configure(runtime,data,files,cache,"owned.window.fixture");
  for(String kind:new String[]{"bridge","graphics","audio"})System.setProperty("klepton."+kind,runtime.resolve("native/libklepton-"+(kind.equals("bridge")?"jvm":kind)+".dylib").toString());
  System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  if(System.getenv("KL_ANDROID_ID_DIRECTORY")!=null)HostProcessIdentity.initializeIds();
  HostFilesystem.installNativeMappings(java.util.List.of(),files);
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  for(String library:libraries)System.load(Path.of(library).toAbsolutePath().toString());
  HostContext.hostPackage("owned.window.fixture","1",1);HostContext.hostApplicationInfo(false,data.resolve("fixture.apk").toString(),data.toString(),data.toString(),28);return HostLooper.main();
 }
}
