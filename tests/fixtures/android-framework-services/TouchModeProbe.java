package maclauncher.android;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Looper;
import android.view.*;
import android.widget.FrameLayout;
import maclauncher.android.framework.*;

/** Original focus drawing and input stages over the shared window service. */
public final class TouchModeProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void pump(Looper loop)throws Exception{for(int i=0;i<5;i++){HostWindowProbe.pump(loop);Thread.sleep(2);}}
    private static Object highlight(View view)throws Exception{var field=View.class.getDeclaredField("mDefaultFocusHighlight");field.setAccessible(true);return field.get(view);}
    public static void run(Activity activity,Looper loop)throws Exception{
        boolean configured=activity.getResources().getBoolean(com.android.internal.R.bool.config_defaultInTouchMode);
        check(configured,"original platform resource starts in touch mode");
        var service=WindowManagerGlobal.getWindowManagerService();
        check(service.isInTouchMode(activity.getDisplayId())==configured,"window service preserves resource-owned initial touch mode");
        check(activity.getWindow().getDecorView().isInTouchMode(),"first attached ViewRoot receives initial touch mode");
        Context themed=new ContextThemeWrapper(activity,android.R.style.Theme);
        FrameLayout layout=new FrameLayout(themed);
        View touch=new View(themed){protected void onDraw(Canvas canvas){canvas.drawColor(Color.BLACK);}};
        touch.setId(901);touch.setWillNotDraw(false);touch.setFocusableInTouchMode(true);touch.setNextFocusDownId(902);
        View keyboard=new View(themed){protected void onDraw(Canvas canvas){canvas.drawColor(Color.BLACK);}};
        keyboard.setId(902);keyboard.setWillNotDraw(false);keyboard.setFocusable(true);keyboard.setFocusableInTouchMode(false);
        layout.addView(touch,new FrameLayout.LayoutParams(160,120));
        var lower=new FrameLayout.LayoutParams(160,120);lower.topMargin=120;layout.addView(keyboard,lower);
        touch.setOnTouchListener((view,event)->{if(event.getActionMasked()==MotionEvent.ACTION_DOWN)view.requestFocus();return true;});
        activity.setContentView(layout);pump(loop);check(touch.requestFocus(),"touch-focusable content receives focus");pump(loop);
        check(touch.isInTouchMode()&&highlight(touch)==null,"initial touch focus retains original drawing without keyboard highlight");
        HostWindowManager.input(HostInput.key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_DPAD_DOWN,0,0));
        HostWindowManager.input(HostInput.key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_DPAD_DOWN,0,0));pump(loop);
        check(!service.isInTouchMode(activity.getDisplayId())&&!keyboard.isInTouchMode(),"original navigation key leaves touch mode");
        check(keyboard.isFocused()&&highlight(keyboard)!=null,"real keyboard navigation preserves original focus highlight");
        HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_DOWN,40,40));
        HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_UP,40,40));pump(loop);
        check(service.isInTouchMode(activity.getDisplayId())&&touch.isInTouchMode(),"original pointer-down restores touch mode");
        check(touch.isFocused()&&highlight(touch)==null&&!keyboard.isFocused(),"pointer focus stops drawing the original keyboard highlight");
        System.out.println("PASS original resource touch mode, keyboard focus highlight and pointer transition");
    }
}
