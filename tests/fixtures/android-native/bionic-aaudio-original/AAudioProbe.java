package maclauncher.android.bridge;
import java.lang.instrument.Instrumentation;
import java.nio.file.Path;
public final class AAudioProbe {
 private static native int initialize(String[] paths);
 private static native void exercise(String core,String library,java.util.function.LongConsumer preparation);
 private static native void complete();
 public static void premain(String ignored,Instrumentation instrumentation){
  System.load(System.getProperty("consumer.core"));
  System.load(System.getProperty("consumer.binding"));
  System.load(System.getProperty("consumer.helper"));
  maclauncher.android.framework.HostProcessIdentity.initializeIds();
 }
 public static void main(String[] args)throws Exception{
  String core=System.getProperty("consumer.core");Path data=Path.of(System.getProperty("bionic.runtime")).getParent();
  var start=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);
  start.setAccessible(true);start.invoke(null,Path.of(System.getProperty("ndk.runtime")),data,data.resolve("files"),data.resolve("cache"),"owned.audio.callback",false,false,false);
  GuestNativeLoader.configure(core,args[0],args[1],AAudioProbe.class.getClassLoader());
  int status=initialize(new String[]{System.getProperty("bionic.abi"),System.getProperty("bionic.root"),System.getProperty("bionic.map"),"/data/local/tmp/maclauncher-bionic/bootstrap.so",System.getProperty("bionic.runtime"),System.getProperty("consumer.binding"),"uid\t10000\ngid\t10000\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:untrusted_app:s0\n","/data/app/org.maclauncher.aaudio/lib/arm64"});
  if(status!=0)throw new IllegalStateException("AAudio control prepare: "+status);
  Throwable[] failure={null};Thread imageOwner=new Thread(()->{
   try{exercise(core,Path.of(args[0],"libaaudio-original-control.so").toString(),image->{if(image==0)throw new AssertionError("No original image owner");});}
   catch(Throwable error){failure[0]=error;}
  },"AAudioImageOwner");imageOwner.start();imageOwner.join();if(failure[0]!=null)throw new AssertionError(failure[0]);
  complete();System.out.println("PASS original Mac AAudio stream; detached original Bionic callback thread, nested API, TLS retirement and close; detached pthread dlopen constructor and unload; no window or GPU");
 }
}
