package maclauncher.android;
import android.os.*;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.view.SurfaceControl;
import android.window.ScreenCapture;
import java.nio.file.*;
import java.util.concurrent.*;
import maclauncher.android.bridge.NativeComposition;
import maclauncher.android.framework.HostBinderRpc;

/** A detached original layer tree. No application layer or display is changed. */
public final class CompositionServer {
 public static void main(String[] args)throws Exception{
  System.out.println("Original detached composition component entered");
  System.load("/system/lib64/libart-authority.so");System.load("/system/lib64/libart-rpc.so");System.load("/system/lib64/libart-platform.so");ArtPlatform.initializeRpc(Integer.parseInt(args[0]));
  Path state=Path.of(args[1]);Files.write(state.resolve("server-pid.tmp"),Integer.toString(android.os.Process.myPid()).getBytes(java.nio.charset.StandardCharsets.UTF_8));Files.move(state.resolve("server-pid.tmp"),state.resolve("server-pid"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
  long deadline=System.nanoTime()+10_000_000_000L;while(!Files.exists(state.resolve("client-pid"))&&System.nanoTime()<deadline)Thread.sleep(5);
  int peerPid=Integer.parseInt(new String(Files.readAllBytes(state.resolve("client-pid")),java.nio.charset.StandardCharsets.UTF_8));
  var root=new SurfaceControl.Builder().setName("Detached JVM composition component").setContainerLayer().build();
  try(var transaction=new SurfaceControl.Transaction()){transaction.setLayerStack(root,0x7ffffffe).show(root).apply();}
  CountDownLatch stopped=new CountDownLatch(1);
  try(var nativeRoot=NativeComposition.serve(root,"/system/lib64/libmaclauncher-composition-surface.so")){
   Binder endpoint=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags){
    if(code==1){reply.writeStrongBinder(nativeRoot);return true;}
    if(code==2){var captured=ScreenCapture.captureLayers(new ScreenCapture.LayerCaptureArgs.Builder(root).setSourceCrop(new Rect(0,0,64,64)).setFrameScale(1f).build());
     if(captured==null)throw new IllegalStateException("Original layer capture failed");
     try(var hardware=captured.getHardwareBuffer()){var wrapped=Bitmap.wrapHardwareBuffer(hardware,captured.getColorSpace());if(wrapped==null)throw new IllegalStateException("Original capture bitmap failed");
      var bitmap=wrapped.copy(Bitmap.Config.ARGB_8888,false);wrapped.recycle();reply.writeInt(bitmap.getPixel(4,4));reply.writeInt(bitmap.getPixel(24,24));reply.writeInt(bitmap.getPixel(60,60));bitmap.recycle();}
     return true;}
    if(code==3){stopped.countDown();return true;}
    if(code==4){System.out.println("Original composition peer exits while a dequeue is waiting");System.exit(0);return true;}
    return false;
   }};
   var peer=new HostBinderRpc.Peer("composition.client","composition.client",peerPid,10000);
   try(var fd=ParcelFileDescriptor.adoptFd(Integer.parseInt(args[2]));var connection=HostBinderRpc.serve(fd,peer,endpoint,4)){
    if(!stopped.await(30,TimeUnit.SECONDS))throw new IllegalStateException("JVM composition client timed out");
   }
  }finally{try(var transaction=new SurfaceControl.Transaction()){transaction.remove(root).apply();}root.release();}
  System.out.println("PASS original detached SurfaceFlinger producer owner retired");
 }
}
