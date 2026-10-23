package maclauncher.android;

import android.app.Application;
import android.content.Context;
import android.os.*;
import android.view.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Original ContextImpl, ViewRootImpl and windowless compositor in an owned process. */
public final class NativeProbeFixture implements AutoCloseable {
 public static NativeProbeFixture current;
 public final Looper loop;
 public final Context context;
 private final HostWindowService windows;
 private final WindowManager manager;
 private final List<View> attached=new ArrayList<>();
 private SurfaceControl output;
 private long sequence;
 public static void main(String[] args)throws Exception {
  try(var fixture=new NativeProbeFixture(args[1],args[2])){
   current=fixture;
   try{Class.forName(args[0]).getMethod("main",String[].class).invoke(null,(Object)new String[0]);}
   catch(java.lang.reflect.InvocationTargetException error){Throwable cause=error.getCause();if(cause instanceof Exception value)throw value;if(cause instanceof Error value)throw value;throw new IllegalStateException(cause);}
   finally{current=null;}
  }
 }
 public NativeProbeFixture(String runtimeArg,String dataArg)throws Exception {
  loop=RuntimeFixture.initialize(runtimeArg,dataArg);
  Path runtime=Path.of(runtimeArg),data=Path.of(dataArg),apk=data.resolve("fixture.apk");
  SyntheticResources.apk(apk,"","Native probe",null);
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
  HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  System.load(System.getProperty("klepton.graphics"));
  HostDisplay.hostPublish(42,960,600,60);HostDisplayEvents.hostSetWakeup(()->{});
  windows=HostApplication.prepare(NativeProbeFixture.class.getClassLoader(),new HostContextServices.PhysicalBindings(false,new maclauncher.android.media.HostAudioManager()));
  Context app=HostApplication.applicationContext();HostApplication.attach(new Application(),app);
  context=app.createDisplayContext(HostDisplay.host());
  manager=context.getSystemService(WindowManager.class);
 }
 public void pump(){HostLooper.drain(loop);long now=System.nanoTime();HostDisplayEvents.hostDispatchFrame(++sequence,now,now+16_666_667,16_666_667,42);HostDisplayEvents.hostPresentFrame();HostLooper.drain(loop);}
 public void until(java.util.function.BooleanSupplier condition,String message)throws Exception {
  long deadline=System.nanoTime()+2_000_000_000L;
  while(!condition.getAsBoolean()&&System.nanoTime()<deadline){pump();Thread.sleep(1);}
  if(!condition.getAsBoolean())throw new AssertionError(message);
 }
 public void attach(View view,int width,int height)throws Exception {
  if(output==null){output=HostSurfaceControl.rootSurfaceControl("native-probe",width,height,new HostSurface.Target(){public boolean submit(int[] pixels,int w,int h,long frame,long time){return true;}public void resize(int w,int h){}});windows.attachOutput(output,width,height);}
  var attributes=new WindowManager.LayoutParams(width,height,WindowManager.LayoutParams.TYPE_APPLICATION,0,android.graphics.PixelFormat.RGBA_8888);
  attributes.token=new Binder();attributes.setTitle("Native probe");
  manager.addView(view,attributes);attached.add(view);
  long deadline=System.nanoTime()+2_000_000_000L;
  while((!view.isAttachedToWindow()||view.getWidth()==0)&&System.nanoTime()<deadline){pump();Thread.sleep(1);}
  if(!view.isAttachedToWindow()||view.getWidth()==0)throw new AssertionError("Original view root did not attach");
  view.getViewRootImpl().windowFocusChanged(true);pump();
 }
 public void resize(View view,int width,int height)throws Exception {
  HostDisplay.hostPublish(42,width,height,60);HostSurfaceControl.resizeRoot(output,width,height);windows.resizeOutput(width,height);
  var attributes=(WindowManager.LayoutParams)view.getLayoutParams();attributes.width=width;attributes.height=height;manager.updateViewLayout(view,attributes);view.requestLayout();pump();
  long deadline=System.nanoTime()+1_000_000_000L;
  while((view.getWidth()!=width||view.getHeight()!=height)&&System.nanoTime()<deadline){pump();Thread.sleep(1);}
  if(view.getWidth()!=width||view.getHeight()!=height)throw new AssertionError("Original root resize did not commit: "+view.getWidth()+"x"+view.getHeight()+" expected "+width+"x"+height);
 }
 public void detach(View view){if(attached.remove(view))manager.removeViewImmediate(view);pump();}
 @Override public void close()throws Exception {
  for(View view:List.copyOf(attached))detach(view);
  if(output!=null){windows.detachOutput();output.release();output=null;}
  HostApplication.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();HostLooper.close(loop);FrameworkResources.shutdown();
 }
}
