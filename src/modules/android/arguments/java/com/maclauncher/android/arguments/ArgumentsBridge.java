package com.maclauncher.android.arguments;

import java.lang.reflect.*;
import java.util.Arrays;

/** Initial application Intent parameters; no launcher or VM command parsing. */
public final class ArgumentsBridge {
    public static void intent(Object intent) throws Throwable {
        String value=System.getenv("MACLAUNCHER_GAME_ARGUMENTS");
        if(intent==null||value==null)return;
        try { intent.getClass().getMethod("putExtra",String.class,String.class).invoke(intent,"maclauncher.arguments",value); }
        catch(InvocationTargetException failure){throw failure.getCause();}
    }
    public static void attach(Object activity,Object context,Object application,Object info) throws Throwable {
        Class<?> owner=Class.forName("maclauncher.android.framework.HostActivity");
        Method original=Arrays.stream(owner.getMethods()).filter(method->method.getName().equals("attach")&&method.getParameterCount()==4).findFirst().orElseThrow();
        try {
            original.invoke(null,activity,context,application,info);
            intent(activity.getClass().getMethod("getIntent").invoke(activity));
        } catch(InvocationTargetException failure){throw failure.getCause();}
    }
}
