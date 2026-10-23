package maclauncher.android.tests;
import android.graphics.Bitmap;import android.view.PointerIcon;
public class CustomPointer {
 static void fails(Runnable work,Class<? extends Throwable> kind){try{work.run();throw new AssertionError("Expected failure");}catch(Throwable error){if(!kind.isInstance(error))throw error;}}
 public static void main(String[] args){
  for(int n=0;n<1000;n++){
   int[] colors={0xff345678,0xff000000|n,0xff00ff00,0xff112233};var bitmap=Bitmap.createBitmap(colors,2,2,Bitmap.Config.ARGB_8888);var icon=PointerIcon.create(bitmap,1.75f,.25f);colors[0]=0;
   int[] values=maclauncher.android.framework.HostInput.cursor(icon);if(icon.getType()!=-1||values.length!=8||values[0]!=2||values[1]!=2||values[2]!=1||values[3]!=0||values[4]!=0xff345678||values[5]!=(0xff000000|n))throw new AssertionError("Pixel ownership");
   values[4]=0;if(maclauncher.android.framework.HostInput.cursor(icon)[4]!=0xff345678)throw new AssertionError("Mutable native snapshot");bitmap.recycle();fails(()->maclauncher.android.framework.HostInput.cursor(icon),IllegalStateException.class);
  }
  var valid=Bitmap.createBitmap(2,2,Bitmap.Config.ARGB_8888);
  for(float x:new float[]{-1,2,Float.POSITIVE_INFINITY})fails(()->PointerIcon.create(valid,x,0),IllegalArgumentException.class);
  for(float y:new float[]{-1,2,Float.NEGATIVE_INFINITY})fails(()->PointerIcon.create(valid,0,y),IllegalArgumentException.class);
  var large=Bitmap.createBitmap(1025,1,Bitmap.Config.ARGB_8888);var oversized=PointerIcon.create(large,0,0);fails(()->maclauncher.android.framework.HostInput.cursor(oversized),IllegalArgumentException.class);large.recycle();valid.recycle();fails(()->maclauncher.android.framework.HostInput.cursor(PointerIcon.create(valid,0,0)),IllegalStateException.class);
  System.out.println("PASS custom cursor1000 detached ARGB snapshots, hotspot/bounds/recycled refusal; no native presentation claim");
 }
}
