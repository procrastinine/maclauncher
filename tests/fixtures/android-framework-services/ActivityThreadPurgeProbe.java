package maclauncher.android.fixture;
import android.app.ActivityThread;
import android.graphics.Bitmap;
import java.lang.reflect.Method;
import maclauncher.android.framework.HostLooper;

public final class ActivityThreadPurgeProbe {
 public static void main(String[] args)throws Exception{
  var looper=RuntimeFixture.initialize(args[0],args[1],args[2]);
  Bitmap live=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);
  live.eraseColor(0xff193f71);
  var constructor=ActivityThread.class.getDeclaredConstructor();constructor.setAccessible(true);
  ActivityThread thread=constructor.newInstance();
  Method purge=ActivityThread.class.getDeclaredMethod("nPurgePendingResources");purge.setAccessible(true);
  Method profiling=ActivityThread.class.getDeclaredMethod("nInitZygoteChildHeapProfiling");profiling.setAccessible(true);
  try{
   purge.invoke(thread);profiling.invoke(thread);
   if(live.getPixel(4,4)!=0xff193f71)throw new AssertionError("Live native bitmap was retired by idle purge");
   live.setPixel(4,4,0xffaaba77);purge.invoke(thread);
   if(live.getPixel(4,4)!=0xffaaba77)throw new AssertionError("Live native bitmap storage changed");
   System.out.println("PASS original ActivityThread allocator natives preserve live native resources");
  }finally{live.recycle();HostLooper.close(looper);}
 }
}
