package maclauncher.android;
import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.content.res.*;
import android.graphics.Canvas;
import android.os.*;
import android.view.*;
import dalvik.system.PathClassLoader;
import java.lang.reflect.*;
import java.nio.file.*;
import java.nio.*;
import android.system.*;
import java.util.*;
import maclauncher.android.framework.*;
/** Original Activity/PhoneWindow bootstrap over shared installed-package/display owners. */
public final class ArtActivityProbe implements AutoCloseable {
 private static final class EndLoop extends RuntimeException {}
 /** Physical event capability; Android's own MessageQueue and ViewRoot own delivery. */
 private static final class PhysicalInput implements AutoCloseable {
  final ParcelFileDescriptor descriptor=ParcelFileDescriptor.adoptFd(6);
  final MessageQueue queue=Looper.myQueue();final View decor;
  final ByteBuffer packet=ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN);
  boolean touch;float lastX,lastY;ByteBuffer text;boolean composing;
  PhysicalInput(View view)throws Exception{
   decor=view;var fd=descriptor.getFileDescriptor();Os.fcntlInt(fd,OsConstants.F_SETFL,Os.fcntlInt(fd,OsConstants.F_GETFL,0)|OsConstants.O_NONBLOCK);
   queue.addOnFileDescriptorEventListener(fd,MessageQueue.OnFileDescriptorEventListener.EVENT_INPUT,(source,events)->{
    try{
     for(;;){int count;
      try{count=Os.read(source,text==null?packet:text);}catch(ErrnoException error){if(error.errno==OsConstants.EAGAIN)return MessageQueue.OnFileDescriptorEventListener.EVENT_INPUT;if(error.errno==OsConstants.EINTR)continue;throw error;}
      if(count==0){focus(false);return 0;}
      if(text!=null){if(text.hasRemaining())continue;text.flip();int start=text.getInt(),length=text.getInt();String value=java.nio.charset.StandardCharsets.UTF_8.decode(text).toString();text=null;HostTextInput.text(value,composing,start,length);continue;}
      if(packet.hasRemaining())continue;
      packet.flip();int kind=packet.getInt(),action=packet.getInt(),code=packet.getInt(),meta=packet.getInt();float x=packet.getFloat(),y=packet.getFloat(),dx=packet.getFloat(),dy=packet.getFloat();packet.clear();
      ViewRootImpl root=decor.getViewRootImpl();if(root==null)continue;
      switch(kind){
       case 1->focus(action!=0);
       case 2->{lastX=x;lastY=y;if(action==MotionEvent.ACTION_DOWN)touch=true;else if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL)touch=false;root.dispatchInputEvent(HostInput.motion(action,x,y));}
       case 3->root.dispatchInputEvent(HostInput.key(action,code,0,meta));
       case 4->{long now=SystemClock.uptimeMillis();var property=new MotionEvent.PointerProperties();property.id=0;property.toolType=MotionEvent.TOOL_TYPE_MOUSE;var position=new MotionEvent.PointerCoords();position.x=x;position.y=y;position.setAxisValue(MotionEvent.AXIS_HSCROLL,dx);position.setAxisValue(MotionEvent.AXIS_VSCROLL,dy);root.dispatchInputEvent(MotionEvent.obtain(now,now,MotionEvent.ACTION_SCROLL,1,new MotionEvent.PointerProperties[]{property},new MotionEvent.PointerCoords[]{position},0,0,1,1,0,0,InputDevice.SOURCE_MOUSE,0));}
       case 5->throw new EndLoop();
       case 6->{if(code<8)throw new IllegalStateException("Invalid native text length");text=ByteBuffer.allocate(code).order(ByteOrder.LITTLE_ENDIAN);composing=action!=0;}
       case 7->HostTextInput.shortcut(code);
       default->throw new IllegalStateException("Unknown physical input record "+kind);
      }
     }
    }catch(ErrnoException|java.io.InterruptedIOException error){throw new IllegalStateException("Physical input capability failed",error);}
   });
  }
  private void focus(boolean value){ViewRootImpl root=decor.getViewRootImpl();if(root==null)return;if(!value&&touch){root.dispatchInputEvent(HostInput.motion(MotionEvent.ACTION_CANCEL,lastX,lastY));touch=false;}root.windowFocusChanged(value);}
  @Override public void close()throws Exception{queue.removeOnFileDescriptorEventListener(descriptor.getFileDescriptor());focus(false);descriptor.close();}
 }

 HostWindowService windows;HostActivityService activityService;View decor;boolean started,resumed;
 final boolean fixture,originalHardwareRenderer;final long duration;final LocalProviders providers=new LocalProviders();
 final Instrumentation instrumentation;final Activity activity;final Class<?> apkType;
 private static void set(Object owner,Class<?> type,String name,Object value)throws Exception{Field f=type.getDeclaredField(name);f.setAccessible(true);f.set(owner,value);}
 private static Object construct(Class<?> type,Class<?>[] types,Object...values)throws Exception{Constructor<?> c=type.getDeclaredConstructor(types);c.setAccessible(true);return c.newInstance(values);}
 private static Object call(Object owner,Class<?> type,String name,Class<?>[] types,Object...values)throws Exception{Method m=type.getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(owner,values);}
 ArtActivityProbe(String path,double[] display)throws Exception{this(path,display,new org.json.JSONObject("{\"packageName\":\"com.maclauncher.artprobe\",\"activityClass\":\"com.maclauncher.artprobe.ProbeActivity\",\"fixture\":true,\"durationMillis\":1200}"));}
 ArtActivityProbe(String path,double[] display,org.json.JSONObject launch)throws Exception{
  fixture=launch.getBoolean("fixture");originalHardwareRenderer=launch.optBoolean("hardwareRenderer",false);duration=launch.getLong("durationMillis");String packageName=launch.getString("packageName"),nativeLibraryDir=launch.optString("nativeLibraryDir","/data/app/native");
  if(Looper.myLooper()==null)Looper.prepareMainLooper();
  Path source=Path.of(path),data=Path.of("/data/user/0/"+packageName);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  System.out.println("Activity bootstrap: private filesystem");
  HostFilesystem.configure(Path.of("/"),data,data.resolve("files"),data.resolve("cache"),packageName);
  System.out.println("Activity bootstrap: package identity");
  HostContext.hostPackage(packageName,"1",1);
  HostContext.hostApplicationInfo(ApplicationInfo.FLAG_HAS_CODE,path,data.toString(),nativeLibraryDir,36);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  set(null,ServiceManager.class,"sServiceManager",HostServices.manager());
  System.out.println("Activity bootstrap: framework resources");
  List<Path> sources=new ArrayList<>();var sourceNames=launch.optJSONArray("sourceApks");
  if(sourceNames==null)sources.add(source);else for(int i=0;i<sourceNames.length();i++)sources.add(Path.of(sourceNames.getString(i)));
  FrameworkResources.configure(Path.of("/system/framework/framework-res.apk"),sources);
  System.out.println("Activity bootstrap: original package inspection");
  var providerInfo=HostPackages.inspectSources(sources);
  System.out.println("Activity bootstrap: committed display");
  HostDisplay.hostPublish((long)display[0],(int)display[1],(int)display[2],(float)display[3],(float)display[4]);
  System.out.println("Activity bootstrap: original process record");
  ApplicationInfo info=HostContext.hostApplicationInfoSnapshot();
  ClassLoader loader=new PathClassLoader(String.join(java.io.File.pathSeparator,sources.stream().map(Path::toString).toList()),nativeLibraryDir,ArtActivityProbe.class.getClassLoader());
  ActivityThread thread=(ActivityThread)construct(ActivityThread.class,new Class<?>[0]);set(null,ActivityThread.class,"sCurrentActivityThread",thread);
  set(thread,ActivityThread.class,"mProfiler",construct(Class.forName("android.app.ActivityThread$Profiler"),new Class<?>[0]));
  Class<?> controller=Class.forName("android.app.ConfigurationController");Object configuration=construct(controller,new Class<?>[]{Class.forName("android.app.ActivityThreadInternal")},thread);
  Configuration cfg=new Configuration(ResourcesManager.getInstance().getConfiguration());
  call(configuration,controller,"setConfiguration",new Class<?>[]{Configuration.class},cfg);call(configuration,controller,"setCompatConfiguration",new Class<?>[]{Configuration.class},cfg);set(thread,ActivityThread.class,"mConfigurationController",configuration);
  instrumentation=new Instrumentation();call(instrumentation,Instrumentation.class,"basicInit",new Class<?>[]{ActivityThread.class},thread);set(thread,ActivityThread.class,"mInstrumentation",instrumentation);
  LoadedApk apk=new LoadedApk(thread,info,CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO,loader,false,true,false);set(apk,LoadedApk.class,"mClassLoader",loader);set(apk,LoadedApk.class,"mDefaultClassLoader",loader);
  Class<?> bind=Class.forName("android.app.ActivityThread$AppBindData");Object binding=construct(bind,new Class<?>[0]);set(binding,bind,"info",apk);set(binding,bind,"appInfo",info);set(binding,bind,"processName",info.processName);set(binding,bind,"config",cfg);set(binding,bind,"compatInfo",CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO);set(thread,ActivityThread.class,"mBoundApplication",binding);
  Class<?> impl=Class.forName("android.app.ContextImpl");Context context=(Context)call(null,impl,"createAppContext",new Class<?>[]{ActivityThread.class,LoadedApk.class},thread,apk);
  System.out.println("Activity bootstrap: shared service registration");
  HostPackages.install(context);set(null,ActivityThread.class,"sPackageManager",HostPackages.service());
  // This private composition has physical network access disabled by its sandbox.
  HostConnectivityManager.configure(false,new HostConnectivityManager.Source(){public long snapshot(){return 0;}public long start(long epoch){return 0;}public void stop(long epoch){}});
  HostConnectivityManager.install(context);
  System.out.println("Activity bootstrap: shared activity service");
  activityService=(HostActivityService)construct(HostActivityService.class,new Class<?>[]{Context.class},context);
  call(null,HostActivity.class,"install",new Class<?>[0]);
  HostInputManager.install();HostInputMethodService.install();HostStorageService.install();
  HostUserService.install(context);HostAppOps.install(context);call(null,HostPermissions.class,"installChecker",new Class<?>[]{Context.class},context);
  call(null,HostPermissions.class,"install",new Class<?>[0]);
  if(launch.optBoolean("nativeServices",false)){
   ArtGraphicsProbe.activity(HostServiceEndpoints.export(activityService,"android.app.IActivityManager",context));
   for(String name:new String[]{"appops","permission_checker"}){
    IBinder local=HostServices.manager().checkService(name);String descriptor=local.getInterfaceDescriptor();
    IInterface original=local.queryLocalInterface(descriptor);
    ArtGraphicsProbe.service(name,original==null?local:HostServiceEndpoints.export(original,descriptor,context));
   }
  }
  call(null,Class.forName("maclauncher.android.framework.HostActivityTasks"),"install",new Class<?>[]{Context.class},context);
  call(null,Class.forName("maclauncher.android.framework.HostUiModeService"),"install",new Class<?>[]{Context.class},context);
  System.setProperty("klepton.audio","/data/local/tmp/graphics.so");
  var audio=new maclauncher.android.media.HostAudioManager();
  maclauncher.android.media.HostAudioService.install(audio,context);
  if(launch.optBoolean("nativeServices",false)){
   ArtGraphicsProbe.audioService(maclauncher.android.media.HostAudioService.nativeEndpoint());
   int count=android.media.AudioSystem.getNumStreamTypes();int[] ranges=new int[count*3];
   for(int stream=0;stream<count;++stream){ranges[stream*3]=audio.getStreamMinVolume(stream);ranges[stream*3+1]=audio.getStreamMaxVolume(stream);ranges[stream*3+2]=audio.getStreamVolume(stream);}
   // Original audio startup is asynchronous. Its native service wait belongs
   // to this worker, not the Activity's main Looper or lifecycle outcome.
   var startup=new Thread(()->{try{ArtGraphicsProbe.audio(ranges);System.out.println("Original native audio policy and shared stream ranges ready");}catch(Throwable failure){System.err.println("Native audio startup failed");failure.printStackTrace();}},"Android native audio startup");
   startup.setDaemon(true);startup.start();
  }
  windows=new HostWindowService(context,originalHardwareRenderer);windows.install();
  System.out.println("Activity bootstrap: original Application");
  Application app=instrumentation.newApplication(loader,info.className==null?"android.app.Application":info.className,context);call(context,impl,"setOuterContext",new Class<?>[]{Context.class},app);set(thread,ActivityThread.class,"mInitialApplication",app);set(apk,LoadedApk.class,"mApplication",app);HostJobScheduler.hostConfigure(app,Looper.getMainLooper());providers.install(context,providerInfo);instrumentation.callApplicationOnCreate(app);
  System.out.println("Activity bootstrap: original Activity context");
  ActivityInfo activityInfo=HostPackages.activityInfo(launch.getString("activityClass"));Binder token=new Binder();
  Context activityContext=(Context)call(null,impl,"createActivityContext",new Class<?>[]{ActivityThread.class,LoadedApk.class,ActivityInfo.class,IBinder.class,int.class,Configuration.class},thread,apk,activityInfo,token,Display.DEFAULT_DISPLAY,cfg);
  Intent intent=new Intent(Intent.ACTION_MAIN).setComponent(new ComponentName(info.packageName,activityInfo.name));
  activity=instrumentation.newActivity(loader,activityInfo.name,intent);apkType=activity.getClass();
  Method attach=Arrays.stream(Activity.class.getDeclaredMethods()).filter(m->m.getName().equals("attach")&&m.getParameterCount()==20).findFirst().orElseThrow();attach.setAccessible(true);
  System.out.println("Activity bootstrap: original Activity attach");
  attach.invoke(activity,activityContext,thread,instrumentation,token,0,app,intent,activityInfo,"ART Activity",null,null,null,cfg,null,null,null,null,new Binder(),new Binder(),null);
  call(activityContext,impl,"setOuterContext",new Class<?>[]{Context.class},activity);activity.setTheme(activityInfo.getThemeResource());
  System.out.println("Activity bootstrap: original Activity create");
  instrumentation.callActivityOnCreate(activity,null);
  if(fixture&&apkType.getField("created").getInt(null)!=1)throw new AssertionError("Original Activity create callback");
  System.out.println("Original APK Activity + PhoneWindow created on shared display "+activity.getDisplay().getWidth()+"x"+activity.getDisplay().getHeight());
 }
 void show(SurfaceControl output,int width,int height)throws Exception{
  windows.attachOutput(output,width,height);windows.attachToken(activity.getActivityToken());
  instrumentation.callActivityOnStart(activity);started=true;HostActivityManager.hostStarted(activity);instrumentation.callActivityOnResume(activity);resumed=true;
  decor=activity.getWindow().getDecorView();var attrs=activity.getWindow().getAttributes();attrs.type=WindowManager.LayoutParams.TYPE_BASE_APPLICATION;attrs.token=activity.getActivityToken();attrs.inputFeatures|=WindowManager.LayoutParams.INPUT_FEATURE_NO_INPUT_CHANNEL;if(!originalHardwareRenderer)attrs.flags&=~WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
  activity.getWindowManager().addView(decor,attrs);
  try(PhysicalInput physical=new PhysicalInput(decor)){
  var handler=new Handler(Looper.getMainLooper());
  decor.getViewTreeObserver().addOnDrawListener(new android.view.ViewTreeObserver.OnDrawListener(){
   boolean scheduled;
   @Override public void onDraw(){if(scheduled)return;scheduled=true;handler.post(()->{
    decor.getViewTreeObserver().removeOnDrawListener(this);
    ViewRootImpl root=decor.getViewRootImpl();if(root==null)throw new AssertionError("Original ViewRoot was not attached");
    System.out.println("Original ViewRoot first draw; observation interval started");
    if(fixture){
     root.windowFocusChanged(true);
     long now=SystemClock.uptimeMillis();
     MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,20,20,0),up=MotionEvent.obtain(now,now,MotionEvent.ACTION_UP,20,20,0);
     down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
     root.dispatchInputEvent(down);root.dispatchInputEvent(up);
    }
    handler.postDelayed(()->{throw new EndLoop();},duration);
   });}
  });
  try{Looper.loop();}catch(EndLoop finished){}
  }
  if(fixture&&apkType.getField("draws").getInt(null)==0)throw new AssertionError("Original ViewRoot did not draw");
  if(fixture&&apkType.getField("touches").getInt(null)!=1)throw new AssertionError("Original ViewRoot input pipeline did not deliver touch");
  System.out.println(fixture?"Original Activity ViewRoot draw/input callbacks passed":"Original APK ViewRoot lifecycle completed");
 }
 void draw(Canvas canvas,int width,int height)throws Exception{
  View view=activity.findViewById(android.R.id.content);view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));view.layout(0,0,width,height);view.draw(canvas);
  long now=SystemClock.uptimeMillis();MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,20,20,0),up=MotionEvent.obtain(now,now,MotionEvent.ACTION_UP,20,20,0);
  try{view.dispatchTouchEvent(down);view.dispatchTouchEvent(up);}finally{down.recycle();up.recycle();}
  if(apkType.getField("draws").getInt(null)!=1||apkType.getField("touches").getInt(null)!=1)throw new AssertionError("Original View draw/input callback");
 }
 @Override public void close()throws Exception{
  Throwable failure=null;
  List<Runnable> retire=new ArrayList<>();
  if(resumed)retire.add(()->{resumed=false;instrumentation.callActivityOnPause(activity);});
  if(started)retire.add(()->{started=false;try{instrumentation.callActivityOnStop(activity);}finally{HostActivityManager.hostStopped(activity);}});
  // Engines can wait for an actual final frame in onPause/onStop. Keep original
  // SurfaceFlinger and the physical display clock live through those callbacks.
  if(decor!=null)retire.add(()->{if(decor.getParent()!=null)activity.getWindowManager().removeViewImmediate(decor);});
  retire.add(windows::close);retire.add(()->instrumentation.callActivityOnDestroy(activity));retire.add(providers::close);
  retire.add(activityService::close);
  for(Runnable operation:retire)try{operation.run();}catch(Throwable error){if(failure==null)failure=error;else if(failure!=error)failure.addSuppressed(error);}
  if(failure instanceof Error error)throw error;if(failure instanceof Exception error)throw error;
  if(fixture&&apkType.getField("destroyed").getInt(null)!=1)throw new AssertionError("Original Activity destroy callback");System.out.println(fixture?"Original Activity destroy callback passed":"Original APK Activity lifecycle completed");
 }
}
