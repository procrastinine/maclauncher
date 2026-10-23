package maclauncher.android.tests;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ShortcutManager;

public final class ShortcutServiceProbe {
    public static void run(Context context){
        if(!Context.SHORTCUT_SERVICE.equals(context.getSystemServiceName(ShortcutManager.class)))throw new AssertionError("Original typed service name");
        var wrapper=new ContextWrapper(context);
        if(wrapper.getSystemService(ShortcutManager.class)!=context.getSystemService(Context.SHORTCUT_SERVICE))throw new AssertionError("Original typed wrapper lookup");
        var endpoint=android.os.ServiceManager.checkService(Context.SHORTCUT_SERVICE);
        if(endpoint!=null&&context.getSystemService(ShortcutManager.class)==null)throw new AssertionError("Published shortcut endpoint requires the original client");
        int[] calls={0};Context intercepted=new ContextWrapper(context){@Override public Object getSystemService(String name){if(!name.equals(Context.SHORTCUT_SERVICE))throw new AssertionError(name);calls[0]++;return null;}};
        if(intercepted.getSystemService(ShortcutManager.class)!=null||calls[0]!=1)throw new AssertionError("Typed helper must preserve virtual dispatch");
    }
}
