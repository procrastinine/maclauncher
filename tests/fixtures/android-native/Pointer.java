package maclauncher.android.tests;
import android.content.Context;
import android.view.PointerIcon;
import android.view.SurfaceView;
public class Pointer {
 public static void main(String[] args)throws Exception {
  Context context=maclauncher.android.NativeProbeFixture.current.context;SurfaceView view=new SurfaceView(context);
  if(view.getPointerIcon()!=null)throw new AssertionError();
  for(int i=0;i<10000;i++){
   int type=1000+i%22;PointerIcon icon=PointerIcon.getSystemIcon(context,type);view.setPointerIcon(icon);
   if(view.getPointerIcon()!=icon||icon.getType()!=type)throw new AssertionError();
  }
  view.setPointerIcon(PointerIcon.getSystemIcon(context,0));if(view.getPointerIcon().getType()!=0)throw new AssertionError();
  view.setPointerIcon(null);if(view.getPointerIcon()!=null)throw new AssertionError();
  if(PointerIcon.getSystemIcon(context,99999).getType()!=99999)throw new AssertionError();
  try{PointerIcon.getSystemIcon(null,1000);throw new AssertionError();}catch(IllegalArgumentException expected){}
  System.out.println("PASS 10004 original pointer state changes, hidden/default/unknown type identity and null context refusal");
 }
}
