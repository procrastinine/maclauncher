package maclauncher.android;

import android.app.Activity;
import android.os.Looper;
import android.view.*;
import android.widget.EditText;
import java.util.*;
import maclauncher.android.framework.*;

/** Exercises the real upstream ViewRoot with no macOS window or desktop input. */
public final class KeyboardTouchProbe {
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    private static void pump(Looper loop)throws Exception{for(int i=0;i<8;i++){HostWindowProbe.pump(loop);Thread.sleep(2);}}
    private static void key(int action,int code){key(action,code,0);}
    private static void key(int action,int code,int meta){HostWindowManager.input(HostInput.key(action,code,0,meta));}
    public static void run(Activity activity,Looper loop)throws Exception {
        HostInput.initialize();
        class Surface extends View {
            final List<MotionEvent> touches=new ArrayList<>();int keys;
            Surface(){super(activity);setFocusableInTouchMode(true);}
            @Override public boolean onTouchEvent(MotionEvent event){touches.add(MotionEvent.obtain(event));return true;}
            @Override public boolean dispatchKeyEvent(KeyEvent event){keys++;return true;}
            void clear(){touches.forEach(MotionEvent::recycle);touches.clear();keys=0;}
        }
        Surface view=new Surface();activity.setContentView(view);view.requestFocus();pump(loop);
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_W);key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_W);pump(loop);
        check(view.touches.size()==3&&view.keys==0&&view.touches.getFirst().getActionMasked()==MotionEvent.ACTION_DOWN&&view.touches.getLast().getActionMasked()==MotionEvent.ACTION_UP,"default WASD controls move and release the touch joystick");view.clear();
        HostInput.configureTouchJoystick("off",.2f,.7f,.15f);
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_W);key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_W);pump(loop);
        check(view.touches.isEmpty()&&view.keys==2,"explicit Off preserves original keyboard events");view.clear();
        HostInput.configureTouchJoystick("wasd-arrows",.2f,.7f,.15f);
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_W);pump(loop);
        check(view.touches.size()==2&&view.touches.get(0).getActionMasked()==MotionEvent.ACTION_DOWN&&view.touches.get(1).getActionMasked()==MotionEvent.ACTION_MOVE,"joystick begins at its center then moves");
        MotionEvent center=view.touches.get(0),north=view.touches.get(1);float cx=center.getX(),cy=center.getY(),radius=cy-north.getY();
        check(center.getPointerId(0)==1&&Math.abs(cx-.2f*319)<.01f&&Math.abs(cy-.7f*239)<.01f&&Math.abs(radius-.15f*240)<.01f,"normalized committed viewport and stable joystick finger");
        long down=center.getDownTime();int count=view.touches.size();key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_W);pump(loop);check(view.touches.size()==count,"key repeats do not accumulate movement or events");
        HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_DOWN,270,70));pump(loop);
        MotionEvent second=view.touches.getLast();check(second.getActionMasked()==MotionEvent.ACTION_POINTER_DOWN&&second.getActionIndex()==1&&second.getPointerCount()==2&&second.getPointerId(0)==1&&second.getPointerId(1)==0,"mouse is an independent second pointer");
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_D);pump(loop);MotionEvent diagonal=view.touches.getLast();int j=diagonal.findPointerIndex(1),m=diagonal.findPointerIndex(0);
        check(Math.abs(Math.hypot(diagonal.getX(j)-cx,diagonal.getY(j)-cy)-radius)<.01&&diagonal.getX(m)==270&&diagonal.getY(m)==70,"diagonals normalize and do not move the mouse finger");
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_DPAD_UP);pump(loop);MotionEvent alias=view.touches.getLast();j=alias.findPointerIndex(1);check(Math.abs(alias.getX(j)-diagonal.getX(diagonal.findPointerIndex(1)))<.01f,"W and arrow aliases do not double an axis");
        HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_UP,270,70));pump(loop);MotionEvent release=view.touches.getLast();check(release.getActionMasked()==MotionEvent.ACTION_POINTER_UP&&release.getActionIndex()==1&&release.getPointerCount()==2&&release.getPressure(1)==0,"mouse releases without ending joystick");
        key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_W);key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_DPAD_UP);key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_D);pump(loop);
        check(view.touches.getLast().getActionMasked()==MotionEvent.ACTION_UP&&view.touches.getLast().getPointerId(0)==1&&view.keys==0,"last joystick release ends the one touch gesture");
        check(view.touches.stream().allMatch(e->e.getDownTime()==down),"all contacts preserve original gesture down time");view.clear();
        int[] cardinal={KeyEvent.KEYCODE_W,KeyEvent.KEYCODE_S,KeyEvent.KEYCODE_A,KeyEvent.KEYCODE_D};
        for(int i=0;i<cardinal.length;i++){
            key(KeyEvent.ACTION_DOWN,cardinal[i]);pump(loop);MotionEvent moved=view.touches.getLast();
            float dx=moved.getX()-cx,dy=moved.getY()-cy;
            check(i==0?Math.abs(dx)<.01f&&Math.abs(dy+radius)<.01f:i==1?Math.abs(dx)<.01f&&Math.abs(dy-radius)<.01f:i==2?Math.abs(dx+radius)<.01f&&Math.abs(dy)<.01f:Math.abs(dx-radius)<.01f&&Math.abs(dy)<.01f,"every cardinal key reaches the original ViewRoot in its configured direction: "+cardinal[i]);
            key(KeyEvent.ACTION_UP,cardinal[i]);pump(loop);view.clear();
        }
        HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_DOWN,270,70));key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A);pump(loop);
        MotionEvent mouseFirst=view.touches.get(1);check(mouseFirst.getActionMasked()==MotionEvent.ACTION_POINTER_DOWN&&mouseFirst.getActionIndex()==1&&mouseFirst.getPointerId(0)==0&&mouseFirst.getPointerId(1)==1,"mouse-first order keeps both pointer IDs stable");
        HostWindowManager.focusOutput(false);pump(loop);check(view.touches.getLast().getActionMasked()==MotionEvent.ACTION_CANCEL&&view.touches.getLast().getPointerCount()==2,"focus loss cancels the entire owned stream once");HostWindowManager.focusOutput(true);pump(loop);view.clear();
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_W,KeyEvent.META_META_ON);key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_W,KeyEvent.META_META_ON);pump(loop);check(view.touches.isEmpty()&&view.keys==2,"Command shortcuts stay keyboard events");view.clear();
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A);pump(loop);check(view.touches.getFirst().getActionMasked()==MotionEvent.ACTION_DOWN,"focus cancellation leaves no retained fingers or movement keys");
        HostSensors.configure("keyboard");key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_Q);pump(loop);
        int[] editingKeys={0};EditText editor=new EditText(activity){@Override public boolean dispatchKeyEvent(KeyEvent event){editingKeys[0]++;return true;}};editor.setSingleLine(true);activity.setContentView(editor);editor.requestFocus();pump(loop);
        key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_W);key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_W);pump(loop);check(editingKeys[0]==2,"editor receives both original movement-key events");
        for(int code:new int[]{KeyEvent.KEYCODE_Q,KeyEvent.KEYCODE_E,KeyEvent.KEYCODE_R}){key(KeyEvent.ACTION_DOWN,code);key(KeyEvent.ACTION_UP,code);}pump(loop);
        check(editingKeys[0]==8,"editor receives every tilt letter down/up instead of keyboard controls consuming it");
        var tiltKeys=HostSensors.class.getDeclaredField("keys");tiltKeys.setAccessible(true);check(((Set<?>)tiltKeys.get(null)).isEmpty(),"entering text mode retires held manual tilt");HostSensors.configure("off");
        activity.setContentView(view);view.requestFocus();pump(loop);view.clear();key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_D);pump(loop);HostWindowManager.detachPresentation();pump(loop);
        var active=HostInput.class.getDeclaredField("stream");active.setAccessible(true);Object stream=active.get(null);var contacts=stream.getClass().getDeclaredField("active");contacts.setAccessible(true);check(((List<?>)contacts.get(stream)).isEmpty(),"teardown retains no contacts");
        view.clear();System.out.println("PASS original multi-pointer ViewRoot input, normalized keyboard joystick, repeats, aliases, text/Command bypass and lifecycle cleanup");
    }
}
