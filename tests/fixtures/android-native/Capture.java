package maclauncher.android.tests;
import android.view.*;
import maclauncher.android.NativeProbeFixture;
import maclauncher.android.framework.*;
public final class Capture {
 static class V extends View {
  int transitions,events;
  V(android.content.Context context){super(context);setFocusableInTouchMode(true);}
  @Override public void onPointerCaptureChange(boolean captured){transitions++;}
  @Override public boolean onCapturedPointerEvent(MotionEvent event){events++;return true;}
 }
 public static void main(String[] args)throws Exception {
  var fixture=NativeProbeFixture.current;var root=new android.widget.FrameLayout(fixture.context);var view=new V(fixture.context);root.addView(view);
  fixture.attach(root,64,48);view.requestFocus();fixture.pump();
  var event=HostInput.relative(MotionEvent.ACTION_MOVE,4,-3,1);
  try{
   if(event.getToolType(0)!=MotionEvent.TOOL_TYPE_MOUSE||event.getSource()!=InputDevice.SOURCE_MOUSE_RELATIVE||event.getButtonState()!=1||event.getAxisValue(MotionEvent.AXIS_X,0)!=4)throw new AssertionError("Relative pointer metadata");
   for(int i=0;i<10000;i++){
    view.requestPointerCapture();if(view.hasPointerCapture()||!HostInputManager.captureRequested(root))throw new AssertionError("Premature capture");
    int before=view.events;root.getViewRootImpl().dispatchInputEvent(MotionEvent.obtain(event));fixture.pump();if(view.events!=before)throw new AssertionError("Premature delivery");
    HostInputManager.captureChanged(root,true);fixture.pump();HostInputManager.captureChanged(root,true);fixture.pump();
    if(!root.hasPointerCapture())throw new AssertionError("Original root capture acknowledgement");
    root.getViewRootImpl().dispatchInputEvent(MotionEvent.obtain(event));fixture.pump();if(view.events!=before+1)throw new AssertionError("Captured delivery");
    root.releasePointerCapture();if(!view.hasPointerCapture()||HostInputManager.captureRequested(root))throw new AssertionError("Release awaits acknowledgement");
    HostInputManager.captureChanged(root,false);fixture.pump();if(view.hasPointerCapture()||HostInputManager.captureRequested(root))throw new AssertionError("Capture retirement");
   }
   if(view.transitions!=20000||view.events!=10000)throw new AssertionError("Original capture callbacks: "+view.transitions+"/"+view.events);
   var wrong=new java.util.concurrent.atomic.AtomicReference<Throwable>();Thread thread=new Thread(()->{try{root.getViewRootImpl().requestLayout();}catch(Throwable failure){wrong.set(failure);}});thread.start();thread.join();if(!(wrong.get() instanceof ViewRootImpl.CalledFromWrongThreadException))throw new AssertionError("Original view-root owner check");
   try{event.getToolType(1);throw new AssertionError("Pointer bounds");}catch(IllegalArgumentException expected){}
  }finally{event.recycle();fixture.detach(root);}
  System.out.println("PASS 10000 asynchronous capture/release acknowledgements, no premature events, original relative source/buttons, owner and pointer bounds");
 }
}
