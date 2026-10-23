package maclauncher.android.bridge;
import java.lang.instrument.Instrumentation;
import java.nio.file.Path;
public final class ChoreographerProbe {
 private static native int initialize(String[] paths);
 private static native void exercise(String core,String library,java.util.function.LongConsumer preparation);
 private static native void complete();
 public static void premain(String ignored,Instrumentation instrumentation){
  System.load(System.getProperty("consumer.core"));System.load(System.getProperty("consumer.binding"));System.load(System.getProperty("consumer.helper"));
  maclauncher.android.framework.HostProcessIdentity.initializeIds();
 }
 public static void main(String[] args)throws Exception{
  String core=System.getProperty("consumer.core");Path data=Path.of(System.getProperty("bionic.runtime")).getParent();
  var start=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);
  start.setAccessible(true);start.invoke(null,Path.of(System.getProperty("ndk.runtime")),data,data.resolve("files"),data.resolve("cache"),"owned.display.callback",false,false,false);
  GuestNativeLoader.configure(core,args[0],args[1],ChoreographerProbe.class.getClassLoader());
  int status=initialize(new String[]{System.getProperty("bionic.abi"),System.getProperty("bionic.root"),System.getProperty("bionic.map"),"/data/local/tmp/maclauncher-bionic/bootstrap.so",System.getProperty("bionic.runtime"),System.getProperty("consumer.binding"),"uid\t10000\ngid\t10000\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:untrusted_app:s0\n"});
  if(status!=0)throw new IllegalStateException("Native display preparation failed: "+status);
  Throwable[] failure={null};Thread imageOwner=new Thread(()->{
   try{android.os.Looper.prepare();exercise(core,Path.of(args[0],"libchoreographer-original-control.so").toString(),image->{if(image==0)throw new AssertionError("No original image owner");});maclauncher.android.framework.HostLooper.close(android.os.Looper.myLooper());}
   catch(Throwable error){failure[0]=error;}
  },"ChoreographerImageOwner");imageOwner.start();imageOwner.join();if(failure[0]!=null)throw new AssertionError(failure[0]);
  complete();if(System.getenv("CHOREOGRAPHER_BASELINE_CONTROL")==null)System.out.println("PASS original Bionic native Choreographer shares Java/native ALooper; legacy, frame64, vsync, refresh, delayed/reposted callbacks and detached retirement; no window or GPU");
 }
}
