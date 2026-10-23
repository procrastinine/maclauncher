package maclauncher.android;

import android.app.Activity;
import android.os.Looper;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import maclauncher.android.framework.*;

/** Original ViewRoot/InputConnection layout, observed only at the physical IME boundary. */
public final class TextInputGeometryProbe {
    private static native float[] snapshot();
    private static native void dispatchText(String text);
    private static native void retireNative();
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void pump(Looper loop)throws Exception{for(int i=0;i<8;i++){HostWindowProbe.pump(loop);Thread.sleep(1);}}
    public static void run(Activity activity,Looper loop)throws Exception{
        System.load(System.getProperty("klepton.graphics"));System.load(System.getProperty("android.fixture.textGeometry"));
        FrameLayout parent=new FrameLayout(activity);EditText editor=new EditText(activity);editor.setSingleLine(true);editor.setText("original layout");
        FrameLayout.LayoutParams attributes=new FrameLayout.LayoutParams(180,60);attributes.leftMargin=40;attributes.topMargin=60;parent.addView(editor,attributes);
        activity.setContentView(parent);editor.requestFocus();editor.setSelection(0);pump(loop);
        check(HostTextInput.active(),"original input connection is active");float[] initial=snapshot();
        check(initial[4]>0&&initial[0]>=40&&initial[0]<220&&initial[1]>=60&&initial[3]>initial[1],"original insertion marker reaches the physical boundary");
        long[] observed={0};editor.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence value,int start,int count,int after){}public void onTextChanged(CharSequence value,int start,int before,int count){observed[0]=System.nanoTime();}public void afterTextChanged(android.text.Editable value){}});
        long[] delays=new long[32];for(int i=0;i<delays.length;i++){editor.setText("");observed[0]=0;long begin=System.nanoTime();dispatchText("x");check(observed[0]>=begin,"native callback commits on the original editor thread without a queue wait");delays[i]=observed[0]-begin;}
        java.util.Arrays.sort(delays);double commitP95=delays[30]/1000.0,commitMax=delays[31]/1000.0;editor.setText("original layout");editor.setSelection(0);pump(loop);initial=snapshot();
        parent.setTranslationX(13);parent.setTranslationY(17);pump(loop);float[] moved=snapshot();
        check(Math.abs(moved[0]-initial[0]-13)<.01&&Math.abs(moved[1]-initial[1]-17)<.01,"ancestor transform follows the original Android matrix");
        editor.setSelection(editor.length());pump(loop);float[] caret=snapshot();check(caret[0]>moved[0],"original selection moves the native insertion marker");
        editor.scrollTo(9,0);pump(loop);float[] scrolled=snapshot();check(Math.abs(scrolled[0]-caret[0]+9)<.01,"original editor scrolling is included once");
        var field=HostTextInput.class.getDeclaredField("geometry");field.setAccessible(true);Object geometry=field.get(null);var update=geometry.getClass().getDeclaredMethod("update");update.setAccessible(true);
        long start=System.nanoTime();for(int i=0;i<1000;i++)update.invoke(geometry);double micros=(System.nanoTime()-start)/1000.0/1000;
        check(snapshot()[4]==scrolled[4],"unchanged caret does not repeatedly cross JNI");
        View replacement=new View(activity);replacement.setFocusableInTouchMode(true);activity.setContentView(replacement);replacement.requestFocus();pump(loop);
        check(field.get(null)==null&&!HostTextInput.active(),"detached connection retires its geometry observer");float retired=snapshot()[4];editor.scrollTo(15,0);pump(loop);
        check(snapshot()[4]==retired,"retired editor cannot publish stale geometry");
        retireNative();System.out.println("PASS original editor caret, transforms, scrolling, unchanged publication and lifetime; unchanged update average "+micros+"us; native callback to original TextWatcher p95 "+commitP95+"us max "+commitMax+"us");
    }
}
