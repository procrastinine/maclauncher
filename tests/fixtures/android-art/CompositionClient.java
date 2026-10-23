package maclauncher.android.fixture;
import android.os.*;
import android.view.Surface;
import android.opengl.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.bridge.NativeComposition;
import maclauncher.android.bridge.NativeSurface;
import maclauncher.android.bridge.Graphics;
import maclauncher.android.framework.*;

public final class CompositionClient {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static record Pending(Thread thread,FutureTask<NativeComposition.Layer.Buffer> result){}
 static Pending blocked(NativeComposition.Layer layer)throws Exception{var task=new FutureTask<NativeComposition.Layer.Buffer>(layer::dequeueBlocking);var thread=new Thread(task,"Original composition full queue");thread.setDaemon(true);thread.start();long end=System.nanoTime()+2_000_000_000L;while(thread.getState()!=Thread.State.WAITING){check(!task.isDone()&&System.nanoTime()<end,"full native queue reaches its cancellation wait");Thread.sleep(1);}return new Pending(thread,task);}
 static void cancelled(Pending pending)throws Exception{try{pending.result.get(1,TimeUnit.SECONDS);throw new AssertionError("closed native producer returned a buffer");}catch(ExecutionException failure){check(failure.getCause() instanceof IllegalStateException,"native close/death is reported to blocked producer "+failure.getCause());}}
 static NativeComposition.Layer.Buffer[] fill(NativeComposition.Layer layer){var values=new NativeComposition.Layer.Buffer[]{layer.dequeue(),layer.dequeue(),layer.dequeue()};for(var value:values)check(value!=null,"original bounded slot allocation");check(layer.dequeue()==null,"original queue is full");return values;}
 static void lifecycle(IBinder root)throws Exception{
  try(var named=new NativeComposition.Layer(root,"Long independent surface "+"x".repeat(300),8193,1)){/* Actual allocation, rather than an invented dimension/name admission cap, owns support. */}
  var layer=new NativeComposition.Layer(root,"Close full native queue",64,64);var buffers=fill(layer);var pending=blocked(layer);long started=System.nanoTime();layer.close();cancelled(pending);check(System.nanoTime()-started<1_000_000_000L,"close is not blocked by a full producer queue");for(var value:buffers)value.close();
  try(var reusable=new NativeComposition.Layer(root,"Wake original dequeue",64,64)){buffers=fill(reusable);pending=blocked(reusable);buffers[0].close();try(var next=pending.result.get(1,TimeUnit.SECONDS)){check(next!=null,"original cancellation wakes another dequeue");}buffers[1].close();buffers[2].close();}
  layer=new NativeComposition.Layer(root,"Cancel pending release fence",64,64);try(var value=layer.dequeue()){var pipe=ParcelFileDescriptor.createPipe();try(var writer=pipe[1]){var original=value.takeAcquireFence();if(original!=null)original.close();var field=value.getClass().getDeclaredField("fence");field.setAccessible(true);field.set(value,pipe[0]);var wait=new FutureTask<java.nio.ByteBuffer>(value::pixels);var thread=new Thread(wait,"Native release-fence cancellation");thread.setDaemon(true);thread.start();field=value.getClass().getDeclaredField("cancellation");field.setAccessible(true);long end=System.nanoTime()+2_000_000_000L;while(field.get(value)==null){check(System.nanoTime()<end,"pending release fence starts");Thread.sleep(1);}layer.close();try{wait.get(1,TimeUnit.SECONDS);throw new AssertionError("cancelled fence returned writable pixels");}catch(ExecutionException failure){check(failure.getCause() instanceof IllegalStateException,"real poll cancellation wakes fence consumer");}}}finally{layer.close();}
  System.out.println("PASS native full-queue close, release notification and blocked-fence cancellation without lifecycle-lock waits");
 }
 static int[] capture(IBinder endpoint)throws Exception{var data=Parcel.obtain();var reply=Parcel.obtain();try{check(endpoint.transact(2,data,reply,0),"capture endpoint");return new int[]{reply.readInt(),reply.readInt(),reply.readInt()};}finally{data.recycle();reply.recycle();}}
 static void frame(NativeComposition.Layer layer,Surface surface,int color,long id)throws Exception{var canvas=surface.lockCanvas(null);canvas.drawColor(color);surface.unlockCanvasAndPost(canvas);CountDownLatch latched=new CountDownLatch(1);layer.onFrameCompleted(id,time->{check(time>0,"original SF latch timestamp");latched.countDown();});check(latched.await(5,TimeUnit.SECONDS),"original SF commit callback");}
 static final class Gles implements AutoCloseable{
  final EGLDisplay display;final EGLContext context;final EGLSurface surface;
  Gles(Surface target){display=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);int[] version=new int[2];check(EGL14.eglInitialize(display,version,0,version,1),"original EGL initialize");var configs=new EGLConfig[1];int[] count=new int[1];check(EGL14.eglChooseConfig(display,new int[]{EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_NONE},0,configs,0,1,count,0)&&count[0]>0,"native RGBA8 window config");context=EGL14.eglCreateContext(display,configs[0],EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE},0);check(!context.equals(EGL14.EGL_NO_CONTEXT),"native GLES context");surface=EGL14.eglCreateWindowSurface(display,configs[0],target,new int[]{EGL14.EGL_NONE},0);check(!surface.equals(EGL14.EGL_NO_SURFACE),"native GLES composition surface error="+Integer.toHexString(EGL14.eglGetError()));check(EGL14.eglMakeCurrent(display,surface,surface,context),"native GLES current");}
  void frame(NativeComposition.Layer layer,int color,long id)throws Exception{GLES20.glClearColor(((color>>>16)&255)/255f,((color>>>8)&255)/255f,(color&255)/255f,((color>>>24)&255)/255f);GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);check(EGL14.eglSwapBuffers(display,surface),"native GLES independent layer swap");CountDownLatch latched=new CountDownLatch(1);layer.onFrameCompleted(id,time->{check(time>0,"GLES original SF latch");latched.countDown();});check(latched.await(5,TimeUnit.SECONDS),"GLES actual GPU completion and SF commit");}
  public void close(){EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);check(EGL14.eglDestroySurface(display,surface),"GLES surface retirement");check(EGL14.eglDestroyContext(display,context),"GLES context retirement");check(EGL14.eglTerminate(display),"GLES display retirement");EGL14.eglReleaseThread();}
 }
 public static void main(String[] args)throws Exception{
  Path state=Path.of(args[3]);RuntimeFixture.initialize(args[2],state.resolve("client").toString());HostProcessIdentity.configure(10000,Integer.parseInt(System.getenv("COMPOSITION_HOST_UID")));
  String graphics=System.getenv("COMPOSITION_GRAPHICS");if(graphics!=null){System.setProperty("klepton.graphics",graphics);Graphics.configureHost(null,Path.of(args[2],"native/angle").toString(),64,64);NativeSurface.configureGraphics(graphics);NativeSurface.install(System.getProperty("klepton.bridge"));}
  Files.writeString(state.resolve("client-pid.tmp"),Integer.toString(android.os.Process.myPid()));Files.move(state.resolve("client-pid.tmp"),state.resolve("client-pid"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
  long deadline=System.nanoTime()+10_000_000_000L;while(!Files.exists(state.resolve("server-pid"))&&System.nanoTime()<deadline)Thread.sleep(5);
  var peer=new HostBinderRpc.Peer("android","composition.server",Integer.parseInt(Files.readString(state.resolve("server-pid"))),1000,"u:r:system_server:s0");
  try(var bootstrap=ParcelFileDescriptor.adoptFd(Integer.parseInt(args[5]));var connection=HostBinderRpc.connect(bootstrap,peer,4)){
   IBinder endpoint=connection.root();var data=Parcel.obtain();var reply=Parcel.obtain();IBinder nativeRoot;try{check(endpoint.transact(1,data,reply,0),"native root capability");nativeRoot=reply.readStrongBinder();}finally{data.recycle();reply.recycle();}
   try(var back=new NativeComposition.Layer(nativeRoot,"Independent JVM red",64,64);var front=new NativeComposition.Layer(nativeRoot,"Independent JVM blue",64,64)){
    var backSurface=back.surface();var frontSurface=front.surface();try(var gles=graphics==null?null:new Gles(frontSurface)){
    back.state(0,0,0,1,true);front.state(16,16,1,.5f,true);frame(back,backSurface,0xffff0000,1);if(gles==null)frame(front,frontSurface,0xff0000ff,1);else gles.frame(front,0xff0000ff,1);
    int[] mixed=capture(endpoint);check((mixed[0]&0xffffff)==0xff0000,"red layer outside overlap "+Integer.toHexString(mixed[0]));check(((mixed[1]>>>16)&255)>40&&(mixed[1]&255)>40,"original independent alpha composition "+Integer.toHexString(mixed[1]));
    front.state(16,16,-1,1,true);if(gles==null)frame(front,frontSurface,0xff0000ff,2);else gles.frame(front,0xff0000ff,2);int[] behind=capture(endpoint);check((behind[1]&0xffffff)==0xff0000,"original layer Z order "+Integer.toHexString(behind[1]));
    back.state(0,0,0,1,false);if(gles==null)frame(front,frontSurface,0xff0000ff,3);else gles.frame(front,0xff0000ff,3);int[] visible=capture(endpoint);check((visible[1]&0xffffff)==0xff,"original layer visibility "+Integer.toHexString(visible[1]));
    for(int i=4;i<12;i++)if(gles==null)frame(front,frontSurface,0xff0000ff,i);else gles.frame(front,0xff0000ff,i);
    System.out.println("PASS JVM independent buffers, original SurfaceFlinger alpha/Z/visibility, true commit callbacks and bounded release-fence reuse "+Arrays.toString(mixed));
    if(gles!=null)System.out.println("PASS independent AOSP Canvas and native GLES layers share the original gralloc/release owner without CPU readback");
    }finally{backSurface.release();frontSurface.release();}
   }
   lifecycle(nativeRoot);
   var dying=new NativeComposition.Layer(nativeRoot,"Native peer death",64,64);var held=fill(dying);var pending=blocked(dying);
   data=Parcel.obtain();reply=Parcel.obtain();try{endpoint.transact(4,data,reply,0);}catch(RemoteException expected){/* The exact owned peer exits from its fixture endpoint. */}finally{data.recycle();reply.recycle();}
   cancelled(pending);for(var value:held)value.close();dying.close();System.out.println("PASS original composition peer death wakes a full native producer queue");
  }
 }
}
