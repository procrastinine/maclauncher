import android.os.IBinder;
import android.view.InputEvent;
import android.view.KeyEvent;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** Executes original Android methods and the shared completion owner, no window. */
public final class UiHooksProbe {
    static Field field(Class<?> type,String name)throws Exception{Field result=type.getDeclaredField(name);result.setAccessible(true);return result;}
    public static void main(String[] args) {
        // RuntimeInit redirects System streams to Android's log service. This
        // no-service proof reports through the original process descriptors.
        try { run(); }
        catch(Throwable failure) {
            failure.printStackTrace(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.err)));
            System.exit(1);
        }
    }
    private static void run()throws Exception {
        Class<?> rootType=Class.forName("android.view.ViewRootImpl"),queuedType=Class.forName("android.view.ViewRootImpl$QueuedInputEvent");
        Class<?> unsafeType=Class.forName("sun.misc.Unsafe");Object unsafe=field(unsafeType,"theUnsafe").get(null);
        Object root=unsafeType.getMethod("allocateInstance",Class.class).invoke(unsafe,rootType);
        Constructor<?> queueConstructor=queuedType.getDeclaredConstructor();queueConstructor.setAccessible(true);
        Method finish=rootType.getDeclaredMethod("finishInputEvent",queuedType);finish.setAccessible(true);
        Class<?> owner=Class.forName("maclauncher.android.framework.HostWindowManager");
        @SuppressWarnings("unchecked")Map<InputEvent,Consumer<Boolean>> completions=(Map<InputEvent,Consumer<Boolean>>)field(owner,"inputCompletions").get(null);
        int mask=field(queuedType,"FLAG_FINISHED_HANDLED").getInt(null);AtomicInteger calls=new AtomicInteger();
        for(boolean handled:new boolean[]{false,true}){
            KeyEvent event=new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A);Object queued=queueConstructor.newInstance();
            field(queuedType,"mEvent").set(queued,event);field(queuedType,"mFlags").setInt(queued,handled?mask:0);
            completions.put(event,result->{if(result!=handled)throw new AssertionError("Original finished result changed");calls.incrementAndGet();});
            finish.invoke(root,queued);
            if(completions.containsKey(event)||field(queuedType,"mEvent").get(queued)!=null)throw new AssertionError("Completion or original queue retirement was skipped");
        }
        if(calls.get()!=2)throw new AssertionError("Original input completion was not delivered twice");
        Method getToken=rootType.getDeclaredMethod("getInputToken");getToken.setAccessible(true);
        if(getToken.invoke(root)!=null)throw new AssertionError("Unattached original input token changed");
        Class<?> manager=Class.forName("maclauncher.android.framework.HostInputManager");
        Method attach=manager.getDeclaredMethod("attach",rootType,IBinder.class);attach.setAccessible(true);
        Method detach=manager.getDeclaredMethod("detach",rootType);detach.setAccessible(true);
        IBinder token=new android.os.Binder();attach.invoke(null,root,token);
        if(getToken.invoke(root)!=token)throw new AssertionError("Shared native input token was not used");
        detach.invoke(null,root);
        if(getToken.invoke(root)!=null)throw new AssertionError("Retired native input token survived");
        new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out)).println("PASS original ART ViewRoot completion, handled/unhandled results, input-token fallback and retirement");
    }
}
