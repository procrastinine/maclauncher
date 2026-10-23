package maclauncher.android;
import android.graphics.*;
import java.nio.file.Path;
import maclauncher.android.bridge.NativeBinding;
import maclauncher.android.fixture.RuntimeFixture;

public final class NdkBitmapProbe {
 private static native int[] pixels(Bitmap bitmap);
 private static native byte[] compress(Bitmap bitmap,int format);
 private static native int invalid(Bitmap bitmap,boolean recycled);
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]);
  RuntimeFixture.initialize(args[0],args[1]);
  long image=NativeBinding.load(runtime.resolve("native/libklepton-jvm.dylib").toString(),args[2],"libbitmapprobe.so");
  NativeBinding.bind(image,NdkBitmapProbe.class);
  Bitmap bitmap=Bitmap.createBitmap(3,2,Bitmap.Config.ARGB_8888);
  bitmap.eraseColor(0xffff0000);
  int[] values=pixels(bitmap);System.out.println(java.util.Arrays.toString(values));
  check(values[0]==3&&values[1]==2&&values[2]>=12&&values[3]==1,"original NDK bitmap metadata");
  check(values[4]==255&&values[5]==0&&values[6]==0&&values[7]==255,"NDK RGBA bytes");
  check(bitmap.getPixel(1,0)==0xff00ff00,"native writes visible to original Bitmap");
  check(values[8]==0&&values[9]==0,"nested locks share pixels and references");
  for(int format:new int[]{0,1,4}){
   byte[] encoded=compress(bitmap,format);check(encoded.length>20,"encoded image");
   Bitmap decoded=BitmapFactory.decodeByteArray(encoded,0,encoded.length);
   check(decoded!=null&&decoded.getWidth()==3&&decoded.getHeight()==2,"original bitmap compression roundtrip");
   if(format!=0)check(decoded.getPixel(0,0)==0xffff0000&&decoded.getPixel(1,0)==0xff00ff00,"lossless codec RGBA ordering: "+format+" "+Integer.toHexString(decoded.getPixel(0,0))+" "+Integer.toHexString(decoded.getPixel(1,0)));
   decoded.recycle();
  }
  check(invalid(bitmap,false)==0,"original parameter validation");
  bitmap.recycle();
  check(invalid(bitmap,true)==0,"recycled metadata remains available");
  var workers=new java.util.ArrayList<Thread>();var failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
  for(int i=0;i<4;i++){Thread worker=new Thread(()->{try{
   Bitmap independent=Bitmap.createBitmap(128,128,Bitmap.Config.ARGB_8888);independent.eraseColor(0xffff0000);
   for(int j=0;j<16;j++)check(pixels(independent)[4]==255,"independent bitmap lock");independent.recycle();
  }catch(Throwable error){failure.compareAndSet(null,error);}});workers.add(worker);worker.start();}
  for(Thread worker:workers)worker.join();if(failure.get()!=null)throw new AssertionError(failure.get());
  System.out.println("PASS original NDK Bitmap metadata, direct pixels, nested lifetime, JPEG/PNG/WebP compression");
 }
}
