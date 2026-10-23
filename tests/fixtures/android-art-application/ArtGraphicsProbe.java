package maclauncher.android;
import android.os.*;
import android.graphics.*;
import android.media.*;
import maclauncher.android.framework.HostServices;
/** Original Android BufferQueue/mapper pipeline, with no substituted Surface pointers. */
public final class ArtGraphicsProbe {
 private static native long window(boolean open,int width,int height);
 private static native double[] display();
 private static native long present(android.hardware.HardwareBuffer buffer);
 private static native IBinder allocator();
 private static native android.view.SurfaceControl output();
 private static native void services(IBinder manager);
 static native void activity(IBinder manager);
 static native void audio(int[] ranges);
 static native void audioService(IBinder service);
 static native void service(String name,IBinder service);
 static void run(String[]args,IServiceManager platform)throws Exception {
  System.setProperty("klepton.graphics",args[3]);System.load(args[3]);
  HostServices.attachPlatform(platform);
  if(args.length>4&&"surfaceflinger".equals(args[4])){
   var audio=IAudioService.Stub.asInterface(platform.checkService("audio"));
   if(audio==null)throw new IllegalStateException("Canonical audio permission owner is unavailable");
   maclauncher.android.media.HostAudioService.nativePermissionBarrier(()->{try{audio.permissionUpdateBarrier();}catch(RemoteException failure){throw failure.rethrowFromSystemServer();}});
   org.json.JSONObject metric=new org.json.JSONObject(args[5]);double[] dimensions={metric.getLong("screen"),metric.getInt("width"),metric.getInt("height"),metric.getDouble("refresh"),metric.getInt("densityDpi")/160.0};
   android.view.SurfaceControl control=output();try(ArtActivityProbe activity=new ArtActivityProbe("/data/local/tmp/app.apk",dimensions,new org.json.JSONObject(args[6]).put("nativeServices",true))){
    activity.show(control,(int)dimensions[1],(int)dimensions[2]);
   }finally{control.release();HostServices.detachPlatform(platform);}
   return;
  }
  var directory=HostServices.manager();
  directory.addService("android.hardware.graphics.allocator.IAllocator/default",allocator(),false,IServiceManager.DUMP_FLAG_PRIORITY_DEFAULT);
  // A native HAL declaration has no Binder service. The selected real mapper
  // is declared by this fixture; ordinary transactions retain the original directory.
  IBinder declared=new Binder(IServiceManager.DESCRIPTOR){
   @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException {
    System.out.println("Native service lookup "+IServiceManager.Stub.getDefaultTransactionName(code));
    if("isDeclared".equals(IServiceManager.Stub.getDefaultTransactionName(code))){
     int start=data.dataPosition();data.enforceInterface(IServiceManager.DESCRIPTOR);String name=data.readString();
     if("mapper/aim".equals(name)){data.enforceNoDataAvail();reply.writeNoException();reply.writeBoolean(true);return true;}
     data.setDataPosition(start);
    }
    boolean ok=directory.asBinder().transact(code,data,reply,flags);System.out.println("Native directory reply "+code+" "+ok+" bytes="+(reply==null?0:reply.dataSize()));return ok;
   }
  };
  services(declared);
  System.out.println("Original allocator Binder + stable mapper registered");
  var diagnostic=new Thread(()->{try{Thread.sleep(2000);}catch(InterruptedException done){return;}Thread.getAllStackTraces().forEach((thread,stack)->{System.err.println(thread);for(var frame:stack)System.err.println("  "+frame);});},"ART frame diagnostic");diagnostic.setDaemon(true);diagnostic.start();
  long extent=window(true,640,400);System.out.println("Shared physical window "+(extent>>>32)+"x"+(int)extent);
  System.out.println("Creating original ImageReader");
  try(ArtActivityProbe activity=new ArtActivityProbe("/data/local/tmp/app.apk",display());ImageReader reader=ImageReader.newInstance(320,200,PixelFormat.RGBA_8888,2,android.hardware.HardwareBuffer.USAGE_CPU_READ_OFTEN|android.hardware.HardwareBuffer.USAGE_CPU_WRITE_OFTEN)){
   System.out.println("Original ImageReader created");var surface=reader.getSurface();Canvas canvas=surface.lockCanvas(null);
   try{activity.draw(canvas,320,200);}finally{surface.unlockCanvasAndPost(canvas);}
   try(Image image=reader.acquireNextImage()){
    if(image==null)throw new AssertionError("Original BufferQueue did not deliver its frame");
    var plane=image.getPlanes()[0];var bytes=plane.getBuffer();int stride=plane.getRowStride();
    int background=bytes.get(3*stride+3*4)&255,foreground=bytes.get(40*stride+50*4)&255;
    if(background!=0x25||foreground!=0xdc)throw new AssertionError("Original Canvas/BufferQueue pixels "+background+"/"+foreground);
    try(var buffer=image.getHardwareBuffer()){if(present(buffer)<=0)throw new AssertionError("Shared presenter rejected frame");}
    System.out.println("Original Surface Canvas → BufferQueue → ImageReader pixels passed "+image.getWidth()+"x"+image.getHeight()+" stride="+stride);
   }
  }
  window(false,0,0);diagnostic.interrupt();HostServices.detachPlatform(platform);
 }
}
