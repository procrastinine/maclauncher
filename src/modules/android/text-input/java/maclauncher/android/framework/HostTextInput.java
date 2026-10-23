package maclauncher.android.framework;

import android.os.*;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.RectF;
import android.text.InputType;
import android.view.*;
import android.view.inputmethod.*;
import android.widget.TextView;
import com.android.internal.infra.AndroidFuture;
import com.android.internal.inputmethod.*;
import java.lang.reflect.*;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.ProcessAuthority;

/** Native text and explicit clipboard gestures enter Android's existing connection. */
public final class HostTextInput {
    private HostTextInput(){}
    private record Connection(IRemoteInputConnection remote,EditorInfo info,IBinder.DeathRecipient death){}
    private static Connection current;
    private static Geometry geometry;
    private static long compositionRevision;
    private static final Class<?> remoteClass;
    private static final Field session;
    private static final Method associated,connection;
    static {
        try{
            remoteClass=Class.forName("android.view.inputmethod.RemoteInputConnectionImpl");
            session=remoteClass.getDeclaredField("mCurrentSessionId");session.setAccessible(true);
            associated=remoteClass.getDeclaredMethod("isAssociatedWith",View.class);associated.setAccessible(true);
            connection=remoteClass.getDeclaredMethod("getInputConnection");connection.setAccessible(true);
        }catch(ReflectiveOperationException failure){throw new ExceptionInInitializerError(failure);}
    }
    private static native void enableNative(boolean enabled);
    private static native void areaNative(float left,float top,float right,float bottom);
    public interface PhysicalOutput {void enabled(boolean value);void area(float left,float top,float right,float bottom);}
    private static PhysicalOutput physical;
    /** A supplied native window keeps its existing physical IME endpoint. */
    public static AutoCloseable physicalOutput(PhysicalOutput output){if(physical!=null)throw new IllegalStateException("Physical text output is already attached");physical=java.util.Objects.requireNonNull(output);return ()->{if(physical==output)physical=null;};}
    private static void enable(boolean value){if(physical!=null)physical.enabled(value);else enableNative(value);}
    private static void area(float left,float top,float right,float bottom){if(physical!=null)physical.area(left,top,right,bottom);else areaNative(left,top,right,bottom);}
    /** Only physical IME placement lives here; Android owns text layout and selection. */
    private static final class Geometry implements ViewTreeObserver.OnPreDrawListener,View.OnAttachStateChangeListener {
        final Connection owner;final View view;final ViewTreeObserver observer;
        final CursorAnchorInfo.Builder anchor=new CursorAnchorInfo.Builder();
        final Matrix matrix=new Matrix();final Rect focused=new Rect();final RectF bounds=new RectF(),published=new RectF();
        boolean hasPublished;
        Geometry(Connection owner,View view){this.owner=owner;this.view=view;observer=view.getViewTreeObserver();observer.addOnPreDrawListener(this);view.addOnAttachStateChangeListener(this);}
        void close(){if(observer.isAlive())observer.removeOnPreDrawListener(this);view.removeOnAttachStateChangeListener(this);if(geometry==this)geometry=null;}
        void update(){
            if(current!=owner||!usable(owner)){close();enable(false);return;}
            if(!view.isAttachedToWindow()||!view.isShown())return;
            if(view instanceof TextView text){
                CursorAnchorInfo info=text.getCursorAnchorInfo(InputConnection.CURSOR_UPDATE_FILTER_INSERTION_MARKER,anchor,matrix);
                if(info==null)return;
                float x=info.getInsertionMarkerHorizontal(),top=info.getInsertionMarkerTop(),bottom=info.getInsertionMarkerBottom();
                if(!Float.isFinite(x)||!Float.isFinite(top)||!Float.isFinite(bottom))return;
                bounds.set(x,top,x+1,bottom);
            }else{
                view.getFocusedRect(focused);bounds.set(focused);bounds.offset(-view.getScrollX(),-view.getScrollY());
                matrix.reset();view.transformMatrixToGlobal(matrix);
            }
            matrix.mapRect(bounds);
            if(!hasPublished||!published.equals(bounds)){area(bounds.left,bounds.top,bounds.right,bounds.bottom);published.set(bounds);hasPublished=true;}
        }
        @Override public boolean onPreDraw(){update();return true;}
        @Override public void onViewAttachedToWindow(View attached){update();}
        @Override public void onViewDetachedFromWindow(View detached){close();enable(false);}
    }
    public static void connect(IRemoteInputConnection remote,EditorInfo info){
        disconnect();
        if(remote!=null&&info!=null){
            Handler main=Handler.createAsync(Looper.getMainLooper());IBinder binder=remote.asBinder();
            IBinder.DeathRecipient death=()->main.post(()->{if(current!=null&&current.remote.asBinder().equals(binder))shutdown();});
            current=new Connection(remote,info,death);
            try{binder.linkToDeath(death,0);}catch(RemoteException gone){current=null;}
        }
        refresh();
    }
    private static void disconnect(){
        if(geometry!=null)geometry.close();
        var value=current;current=null;compositionRevision++;
        if(value!=null)try{value.remote.asBinder().unlinkToDeath(value.death,0);}catch(java.util.NoSuchElementException unlinked){}
    }
    private static boolean usable(Connection value){
        if(value==null||!remoteClass.isInstance(value.remote))return false;
        View focus=HostWindowManager.focusedView();if(focus==null)return false;
        try{return (Boolean)associated.invoke(value.remote,focus)&&connection.invoke(value.remote)!=null;}
        catch(ReflectiveOperationException failure){throw new IllegalStateException("Android text connection could not be accessed",failure);}
    }
    private static InputConnectionCommandHeader header(Connection value){
        try{return new InputConnectionCommandHeader(((AtomicInteger)session.get(value.remote)).get());}
        catch(IllegalAccessException failure){throw new IllegalStateException("Android text session could not be accessed",failure);}
    }
    public static boolean active(){return usable(current)&&current.info.inputType!=InputType.TYPE_NULL;}
    public static void refresh(){
        boolean enabled=active();if(enabled){HostInput.resetJoystick();HostSensors.reset();}enable(enabled);
        View view=enabled?HostWindowManager.focusedView():null;
        if(geometry!=null&&(geometry.owner!=current||geometry.view!=view))geometry.close();
        if(view!=null){if(geometry==null)geometry=new Geometry(current,view);geometry.update();}
    }
    public static void shutdown(){disconnect();enable(false);}
    public static void text(String text,boolean composing,int start,int length){
        if(HostWindowManager.delegatedText(text,composing,start,length))return;
        Connection value=current;if(!usable(value))return;
        long revision=++compositionRevision;
        try{if(composing){
            value.remote.setComposingText(header(value),text,1);
            int count=text.codePointCount(0,text.length()),from=text.offsetByCodePoints(0,Math.max(0,Math.min(count,start))),to=text.offsetByCodePoints(0,Math.max(0,Math.min(count,start+Math.max(0,length))));
            if(from!=text.length()||to!=from){AndroidFuture<SurroundingText> surrounding=new AndroidFuture<>();
                surrounding.thenAccept(state->{if(state==null||current!=value||compositionRevision!=revision)return;int base=state.getOffset()+state.getSelectionStart()-text.length();if(base<0)return;try{value.remote.setSelection(header(value),base+from,base+to);}catch(RemoteException failure){throw failure.rethrowAsRuntimeException();}});
                value.remote.getSurroundingText(header(value),text.length(),0,0,surrounding);
            }
        }else value.remote.commitText(header(value),text,1);}
        catch(RemoteException failure){throw failure.rethrowAsRuntimeException();}
    }
    public static void shortcut(int code){
        if(HostWindowManager.delegatedShortcut(code))return;
        Connection value=current;if(!usable(value))return;
        Handler main=clipboardHandler();
        if(code==KeyEvent.KEYCODE_V){
            ProcessAuthority.clipboard("paste",null).thenAccept(text->main.post(()->{if(text!=null&&current==value&&usable(value))text(text,false,0,0);}));
        }else if(code==KeyEvent.KEYCODE_C){
            int type=value.info.inputType;
            if((type&InputType.TYPE_MASK_CLASS)==InputType.TYPE_CLASS_TEXT&&((type&InputType.TYPE_MASK_VARIATION)==InputType.TYPE_TEXT_VARIATION_PASSWORD||(type&InputType.TYPE_MASK_VARIATION)==InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)||(type&InputType.TYPE_MASK_CLASS)==InputType.TYPE_CLASS_NUMBER&&(type&InputType.TYPE_MASK_VARIATION)==InputType.TYPE_NUMBER_VARIATION_PASSWORD)return;
            AndroidFuture<CharSequence> selection=new AndroidFuture<>();
            selection.thenAccept(text->{if(current==value&&text!=null&&text.length()!=0)ProcessAuthority.clipboard("copy",text.toString());});
            // Original TextView copy finishes selection action mode, which may
            // collapse its selection. Capture the selected text first while
            // preserving the editor's original private clipboard operation.
            try{value.remote.getSelectedText(header(value),0,selection);value.remote.performContextMenuAction(header(value),android.R.id.copy);}catch(RemoteException failure){throw failure.rethrowAsRuntimeException();}
        }else if(code==KeyEvent.KEYCODE_A||code==KeyEvent.KEYCODE_X){try{value.remote.performContextMenuAction(header(value),code==KeyEvent.KEYCODE_A?android.R.id.selectAll:android.R.id.cut);}catch(RemoteException failure){throw failure.rethrowAsRuntimeException();}}
    }
    /** Clipboard completion is physical input and must cross traversal barriers. */
    private static Handler clipboardHandler(){return Handler.createAsync(Looper.myLooper());}
}
