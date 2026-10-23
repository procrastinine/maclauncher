package maclauncher.android;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.os.*;
import android.view.*;
import java.lang.reflect.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Physical binding substitution under the original Activity/Window lifecycle. */
public final class ArtWindowBindingProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 /** Test observation belongs to the root which is actually drawing. */
 private static final class FirstDraw implements ViewTreeObserver.OnDrawListener,AutoCloseable {
  final View decor;final Handler handler;ViewTreeObserver observer;boolean recorded,closed;
  final Runnable remove=this::remove;
  FirstDraw(View decor,Handler handler){this.decor=decor;this.handler=handler;observer=decor.getViewTreeObserver();observer.addOnDrawListener(this);}
  @Override public void onDraw(){
   if(recorded||closed)return;
   ViewRootImpl root=decor.getViewRootImpl();check(root!=null&&root.getView()==decor,"original ViewRoot owns the drawing decor");
   recorded=true;observer=decor.getViewTreeObserver();handler.post(remove);
  }
  private void remove(){if(observer.isAlive())observer.removeOnDrawListener(this);}
  @Override public void close(){closed=true;handler.removeCallbacks(remove);remove();ViewTreeObserver current=decor.getViewTreeObserver();if(current!=observer&&current.isAlive())current.removeOnDrawListener(this);}
 }
 public static void run(Activity initial,Looper loop)throws Exception{
  check(!maclauncher.android.bridge.WindowSession.attached(),"no JVM window is open");
  if(Boolean.getBoolean("android.fixture.windowRedirect")){redirectBeforeLaunch(initial,loop);return;}
  List<String> events=new ArrayList<>();List<String> states=new ArrayList<>();IBinder capability=new Binder();
  HostActivity.windowBinding((title,width,height,closeRequested,options)->{
   if(options!=null)check(HostActivity.windowCapability(options)==capability,"remote window capability survives the original options");
   events.add("open");
   return new HostActivity.Window(){
    Activity activity;
    public void attachActivity(Activity value){activity=value;events.add("attach");}
    public IBinder capability(){return capability;}
    public void present(Activity value,String title,int w,int h){
     check(value==activity,"same original Activity reaches presentation");HostActivity.resume(value);
     HostWindowManager.attachOutput(value,HostWindowProbe.fixtureOutput,320,240,(a,landscape)->{});
     for(int i=0;i<3;i++)HostWindowProbe.pump(loop);
     check(value.getWindow().getDecorView().getViewRootImpl()!=null,"original PhoneWindow and ViewRoot attach through the supplied output");events.add("present");
     value.finish();for(int i=0;i<3;i++)HostWindowProbe.pump(loop);
     check(value.isDestroyed(),"original ActivityThread owns destruction");
    }
    public void taskEmpty(){events.add("empty");}
    public void hostState(boolean sleeping,boolean focused){states.add(sleeping+":"+focused);}
    public void stopCallbacks(Runnable tasks){events.add("stop");tasks.run();}
    public void close(){events.add("close");}
   };
  });
  try(var window=HostActivity.openWindow("Initial activity",320,240,null)){
   window.attachActivity(initial);check(window.capability()==capability,"initial launch uses the installed typed binding");
   List<String> input=new ArrayList<>();List<java.util.function.Consumer<Boolean>> callbacks=new ArrayList<>();
   HostWindowManager.inputOutput(new HostWindowManager.InputOutput(){
    public boolean input(InputEvent event,java.util.function.Consumer<Boolean> completion){input.add("event");if(completion!=null)callbacks.add(completion);return true;}
    public void wheel(float x,float y,float dx,float dy,boolean touch){check(x==25&&y==30&&dx==.5f&&dy==-1&&touch,"original wheel arguments");input.add("wheel");}
    public void text(String text,boolean composing,int start,int length){check(text.equals("compose")&&composing&&start==1&&length==2,"original composition arguments");input.add("text");}
    public void shortcut(int code){check(code==KeyEvent.KEYCODE_A,"original shortcut");input.add("shortcut");}
   });
   for(int i=0;i<3;i++)HostWindowProbe.pump(loop);
   check(!initial.hasWindowFocus(),"delegated child owns focus instead of the parent ViewRoot");
   List<Boolean> handled=new ArrayList<>();HostWindowManager.input(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A),handled::add);
   check(handled.isEmpty()&&callbacks.size()==1,"queued input is not reported as handled");callbacks.removeFirst().accept(false);check(handled.equals(List.of(false)),"original unhandled completion reaches its caller");
   HostInput.wheel(25,30,.5f,-1,true);HostTextInput.text("compose",true,1,2);HostTextInput.shortcut(KeyEvent.KEYCODE_A);
   check(input.equals(List.of("event","wheel","text","shortcut")),"remote input intents bypass parent target and editor selection");
   HostActivity.hostSleep(true);HostWindowManager.focusOutput(true);HostInput.wheel(25,30,.5f,-1,true);HostTextInput.text("compose",true,1,2);HostTextInput.shortcut(KeyEvent.KEYCODE_A);
   check(HostActivity.hostSleeping()&&states.getLast().equals("true:true")&&input.size()==4,"sleep is forwarded, blocks input and cannot be undone by focus restoration");
   HostActivity.hostSleep(false);check(states.getLast().equals("false:true"),"wake retains physical focus");
   HostWindowManager.input(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A),handled::add);var stale=callbacks.removeFirst();
   HostWindowManager.inputOutput(null);check(handled.equals(List.of(false,false)),"retirement completes existing pending tickets exactly once");stale.accept(true);check(handled.equals(List.of(false,false)),"stale input completion cannot revive the retired lease");
   int focusTurns=0;do{HostWindowProbe.pump(loop);focusTurns++;}while(!initial.hasWindowFocus()&&focusTurns<6);
   check(initial.hasWindowFocus(),"retiring a child restores original parent focus");
   System.out.println("PASS delegated focus retirement: original ViewRoot callback completed in "+focusTurns+" ready-queue turns");
  }
  check(events.equals(List.of("open","attach","close")),"initial output lifetime");events.clear();
  retireInputCapability(initial,loop);
  ActivityInfo info=HostPackages.activityInfo(HostWindowProbe.NextActivity.class.getName());
  Intent intent=new Intent(initial,HostWindowProbe.NextActivity.class);Bundle options=new Bundle();options.putBinder("maclauncher.android.window",capability);
  Method launch=HostActivity.class.getDeclaredMethod("launchOnMain",ActivityInfo.class,Intent.class,IApplicationThread.class,IBinder.class,String.class,int.class,Bundle.class);launch.setAccessible(true);
  try{launch.invoke(null,info,intent,ActivityThread.currentActivityThread().getApplicationThread(),null,null,-1,options);}
  catch(InvocationTargetException error){throw new AssertionError("Shared service Activity launch failed",error.getCause());}
  check(events.equals(List.of("open","attach","present","empty","stop","close")),"service Activity retains one output and ordered retirement: "+events);
  check(HostWindowProbe.NextActivity.lifecycle.containsAll(List.of("create","start","resume","pause","stop","destroy")),"original service Activity lifecycle");
  check(ActivityThread.currentApplication()!=null&&ActivityThread.currentActivityThread().getApplicationThread()!=null,"output retirement preserves the application and Binder endpoint");
  check(!maclauncher.android.bridge.WindowSession.attached(),"neither typed launch allocated a JVM native window");
  delegatedDisplay(loop);
  physicalCloseIntent(loop);
  System.out.println("PASS typed activity windows: initial and service allocation, original ViewRoot/lifecycle, capability options and surviving application");
 }
 private static void redirectBeforeLaunch(Activity trampoline,Looper loop)throws Exception{
  Class<?> type=Class.forName("maclauncher.android.ArtWindows$Window");Constructor<?> constructor=type.getDeclaredConstructor(SurfaceControl.class,boolean.class,IBinder.class,int.class,int.class,Runnable.class);constructor.setAccessible(true);
  HostActivity.Window target=(HostActivity.Window)constructor.newInstance(HostWindowProbe.fixtureOutput,true,null,320,240,null);
  Field running=type.getDeclaredField("running");running.setAccessible(true);
  HostActivity.windowBinding((title,width,height,closeRequested,options)->target);
  var window=HostActivity.openWindow("Activity redirect",320,240,null);
  var pipe=ParcelFileDescriptor.createPipe();
  try(var physical=new ArtActivity.PhysicalInput(pipe[0],null)){
   View firstDecor=trampoline.getWindow().getDecorView();
   window.attachActivity(trampoline);HostActivity.resume(trampoline);running.setBoolean(target,true);
   // An Activity transaction can retire a drawn root before the draw observer's
   // deferred removal. Keep the original ViewRoot traversal and queue ordering.
   var drawObserver=firstDecor.getViewTreeObserver();var handler=new Handler(loop);
   boolean[] detachedBeforeRemoval={false};
   try(var firstDraw=new FirstDraw(firstDecor,handler)){
    drawObserver.addOnDrawListener(new ViewTreeObserver.OnDrawListener(){boolean scheduled;
     public void onDraw(){if(scheduled)return;scheduled=true;handler.postAtFrontOfQueue(()->{
      trampoline.startActivity(new Intent(trampoline,HostWindowProbe.NextActivity.class));
      HostActivity.finish(trampoline);detachedBeforeRemoval[0]=firstDecor.getViewRootImpl()==null;
     });}
    });
    firstDecor.invalidate();
    for(int i=0;i<6&&!trampoline.isDestroyed();i++)HostWindowProbe.pump(loop);
    check(firstDraw.recorded&&detachedBeforeRemoval[0],"original draw is recorded before its Activity detaches and deferred removal survives");
   }
   for(int i=0;i<3;i++)HostWindowProbe.pump(loop);
   var next=HostWindowProbe.NextActivity.instance;
   check(trampoline.isDestroyed()&&!next.isDestroyed()&&!HostActivity.owner(next).closing(),"finish-before-startActivity retains the successor and original ART presentation loop");
   check(firstDecor.getViewRootImpl()==null,"retired Activity decor no longer owns a ViewRoot");
   int[] touches={0};View current=new View(next);current.setOnTouchListener((view,event)->{if(event.getActionMasked()==MotionEvent.ACTION_UP)touches[0]++;return true;});next.setContentView(current);
   HostWindowManager.focusOutput(true);for(int i=0;i<4;i++)HostWindowProbe.pump(loop);
   check(current.getViewRootImpl()!=null&&next.hasWindowFocus(),"successor owns the original focused ViewRoot");
   var packet=java.nio.ByteBuffer.allocate(64).order(java.nio.ByteOrder.LITTLE_ENDIAN);
   for(int action:new int[]{MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP})packet.putInt(2).putInt(action).putInt(0).putInt(0).putFloat(40).putFloat(40).putFloat(0).putFloat(0);
   check(android.system.Os.write(pipe[1].getFileDescriptor(),packet.array(),0,64)==64,"native input capability accepts complete pointer records");
   long until=System.nanoTime()+1_000_000_000L;while(touches[0]==0&&System.nanoTime()<until){HostWindowProbe.pump(loop);Thread.sleep(1);}
   check(touches[0]==1,"physical pipe input reaches the successor instead of its detached predecessor");
   next.finish();boolean ended=false;
   try{for(int i=0;i<3;i++)HostWindowProbe.pump(loop);}catch(RuntimeException terminal){if(!terminal.getClass().getName().equals("maclauncher.android.ArtWindows$EndWindow"))throw terminal;ended=true;}
   check(ended&&next.isDestroyed(),"the same ART loop ends only after the final successor retires");
  }finally{pipe[1].close();running.setBoolean(target,false);HostWindowManager.detachPresentation();window.close();}
  System.out.println("PASS physical input capability: original MessageQueue pipe delivery survives Activity replacement");
  System.out.println("PASS first draw ownership: original traversal survives Activity detachment before observer removal");
  System.out.println("PASS original finish-before-launch redirect: successor survives, final task retirement ends the ART loop");
 }
 private static void delegatedDisplay(Looper loop)throws Exception{
  long original=HostDisplay.hostScreenId();var metrics=new android.util.DisplayMetrics();HostDisplay.metrics(metrics);float refresh=HostDisplay.host().getRefreshRate(),density=metrics.density;
  Class<?> type=Class.forName("maclauncher.android.ArtWindows$Window");Constructor<?> constructor=type.getDeclaredConstructor(SurfaceControl.class,boolean.class,IBinder.class,int.class,int.class,Runnable.class);constructor.setAccessible(true);
  HostActivity.Window window=(HostActivity.Window)constructor.newInstance(HostWindowProbe.fixtureOutput,true,null,320,240,null);
  try{
   // This is the actual geometry writer shared by OPEN and RESIZE, and the
   // real receiver publishes into the existing complete Android display owner.
   long screen=0xf1234567L;HostDisplay.hostPublish(screen,320,240,75,1.5f);
   Method geometry=type.getDeclaredMethod("geometry",Parcel.class);geometry.setAccessible(true);
   Parcel packet=Parcel.obtain();try{geometry.invoke(window,packet);packet.setDataPosition(0);check(packet.readLong()==screen,"OPEN retains the original unsigned screen identity");check(packet.readInt()==320&&packet.readInt()==240&&packet.readFloat()==75&&packet.readFloat()==1.5f,"OPEN retains committed geometry, refresh and density");packet.enforceNoDataAvail();}finally{packet.recycle();}
   Field field=type.getDeclaredField("input");field.setAccessible(true);IBinder input=(IBinder)field.get(window);Field code=ArtWindows.class.getDeclaredField("RESIZE");code.setAccessible(true);
   long movedScreen=0xe2345678L;Parcel changed=Parcel.obtain(input);try{changed.writeInterfaceToken("maclauncher.android.ArtWindowInput");changed.writeLong(movedScreen);changed.writeInt(320);changed.writeInt(240);changed.writeFloat(90);changed.writeFloat(2);input.transact(code.getInt(null),changed,null,IBinder.FLAG_ONEWAY);}finally{changed.recycle();}
   HostWindowProbe.pump(loop);
   check(HostDisplay.hostScreenId()==movedScreen&&HostDisplay.host().getDisplayId()==Display.DEFAULT_DISPLAY,"RESIZE preserves source identity and the original Android default display ID");
   HostDisplay.metrics(metrics);check(metrics.widthPixels==320&&metrics.heightPixels==240&&metrics.density==2&&HostDisplay.host().getRefreshRate()==90,"RESIZE publishes through the actual shared display owner");
   try{HostDisplay.hostPublish(0,320,240,60,1);throw new AssertionError("Invalid source identity accepted");}catch(IllegalArgumentException expected){}
  }finally{window.close();HostDisplay.hostPublish(original,320,240,refresh,density);}
  System.out.println("PASS delegated display identity: OPEN geometry, RESIZE publication and original display validation");
 }
 private static void retireInputCapability(Activity activity,Looper loop)throws Exception{
  Class<?> type=Class.forName("maclauncher.android.ArtWindows$Window");Constructor<?> constructor=type.getDeclaredConstructor(SurfaceControl.class,boolean.class,IBinder.class,int.class,int.class,Runnable.class);constructor.setAccessible(true);
  HostActivity.Window window=(HostActivity.Window)constructor.newInstance(HostWindowProbe.fixtureOutput,true,null,320,240,null);window.attachActivity(activity);
  Field inputField=type.getDeclaredField("input");inputField.setAccessible(true);IBinder input=(IBinder)inputField.get(window);
  Field stateCode=ArtWindows.class.getDeclaredField("STATE"),retireCode=ArtWindows.class.getDeclaredField("RETIRE");stateCode.setAccessible(true);retireCode.setAccessible(true);
  for(boolean sleeping:new boolean[]{true,false}){
   Parcel packet=Parcel.obtain(input);packet.writeInterfaceToken("maclauncher.android.ArtWindowInput");packet.writeBoolean(sleeping);packet.writeBoolean(true);input.transact(stateCode.getInt(null),packet,null,IBinder.FLAG_ONEWAY);packet.recycle();
   long deadline=System.nanoTime()+1_000_000_000L;
   do{HostWindowProbe.pump(loop);if(HostActivity.hostSleeping()==sleeping)break;Thread.sleep(1);}while(System.nanoTime()<deadline);
   check(HostActivity.hostSleeping()==sleeping,"remote host state enters the same Activity lifecycle owner");
  }
  java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<>();
  Thread binder=new Thread(()->{Parcel packet=Parcel.obtain(input);try{packet.writeInterfaceToken("maclauncher.android.ArtWindowInput");input.transact(read(retireCode),packet,null,IBinder.FLAG_ONEWAY);}catch(Throwable error){failure.set(error);}finally{packet.recycle();}},"window-retirement-binder");binder.start();binder.join(1000);
  check(!binder.isAlive()&&failure.get()==null,"retirement transaction returns while the UI Looper is not progressing");
  check(!activity.isDestroyed(),"Binder thread does not execute Activity lifecycle callbacks");HostWindowProbe.pump(loop);
  check(activity.isDestroyed(),"logical parent retirement reaches original Activity destruction");HostWindowManager.detachPresentation();window.close();
 }
 private static void physicalCloseIntent(Looper loop)throws Exception{
  int[] requested={0};Runnable notify=()->requested[0]++;
  ArtWindows.install(HostWindowProbe.fixtureOutput,true);
  Field binding=HostActivity.class.getDeclaredField("windowBinding");binding.setAccessible(true);
  var factory=(HostActivity.WindowBinding)binding.get(null);
  try(var window=factory.open("Close intent",320,240,notify,null)){
   Field callback=window.getClass().getDeclaredField("closeRequested");callback.setAccessible(true);
   Runnable carried=(Runnable)callback.get(window);check(carried==notify,"ART binding retains the same close-intent owner");
   var eof=ParcelFileDescriptor.createPipe();
   try(var physical=new ArtActivity.PhysicalInput(eof[0],carried)){
    eof[1].close();for(int i=0;i<3;i++)HostWindowProbe.pump(loop);
    check(requested[0]==0,"input transport EOF is not an intentional window close");
   }finally{eof[1].close();}
   var pipe=ParcelFileDescriptor.createPipe();
   try(var physical=new ArtActivity.PhysicalInput(pipe[0],carried)){
    byte[] bytes=java.nio.ByteBuffer.allocate(32).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(5).array();
    check(android.system.Os.write(pipe[1].getFileDescriptor(),bytes,0,bytes.length)==bytes.length,"native close record is written");
    boolean ended=false;long until=System.nanoTime()+1_000_000_000L;
    while(!ended&&System.nanoTime()<until)try{HostWindowProbe.pump(loop);Thread.sleep(1);}catch(RuntimeException terminal){if(!terminal.getClass().getName().equals("maclauncher.android.ArtActivity$EndLoop"))throw terminal;check(requested[0]==1,"close intent precedes the lifecycle exit");ended=true;}
    check(ended&&requested[0]==1,"one physical close reaches the shared process authority");
   }finally{pipe[1].close();}
  }
  check(requested[0]==1,"resource retirement does not issue another close intent");
  System.out.println("PASS physical close intent: original queue notifies the shared authority before exit; EOF and retirement preserve failure detection");
 }
 private static int read(Field field){try{return field.getInt(null);}catch(IllegalAccessException error){throw new AssertionError(error);}}

}
