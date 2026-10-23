package maclauncher.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Looper;
import java.util.*;

/** Exercises the original SharedPreferencesImpl via a real ContextImpl. */
public final class PreferenceStringSetProbe {
    private static void check(boolean value){if(!value)throw new AssertionError("Original preference contract");}
    public static void run(Context context)throws Exception{
        SharedPreferences prefs=context.getSharedPreferences("sets",Context.MODE_PRIVATE);
        check(prefs.getClass().getName().equals("android.app.SharedPreferencesImpl"));
        var expected=new LinkedHashSet<>(List.of("", "a<&>\"'", "資料🎮", "line\r\n\t"));
        List<String> events=new ArrayList<>();
        SharedPreferences.OnSharedPreferenceChangeListener listener=(store,key)->{check(Thread.currentThread()==Looper.getMainLooper().getThread());events.add(key);};
        prefs.registerOnSharedPreferenceChangeListener(listener);
        try{
            check(prefs.getStringSet("absent",null)==null);
            var value=new LinkedHashSet<>(expected);var editor=prefs.edit().putStringSet("persisted",value);value.clear();
            check(!prefs.contains("persisted"));check(editor.commit());check(events.equals(List.of("persisted")));
            check(prefs.getStringSet("persisted",null).equals(expected));
            check(context.getSharedPreferences("sets",0)==prefs);
            events.clear();
            var workerFailure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
            Thread worker=new Thread(()->{
                try{prefs.edit().putString("worker","complete").apply();}
                catch(Throwable failure){workerFailure.set(failure);}
            },"original-preference-worker");
            worker.start();worker.join(5000);
            check(!worker.isAlive());
            if(workerFailure.get()!=null)throw new AssertionError("Original worker preference dispatch",workerFailure.get());
            check(events.isEmpty());
            maclauncher.android.framework.HostLooper.drain(Looper.getMainLooper());
            check(events.equals(List.of("worker"))&&prefs.getString("worker",null).equals("complete"));
            events.clear();check(prefs.edit().putStringSet("persisted",expected).commit());check(events.isEmpty());
            check(prefs.edit().putString("typed","string").commit());
            try{prefs.getStringSet("typed",null);throw new AssertionError();}catch(ClassCastException good){}
            check(prefs.edit().putStringSet("typed",Set.of("set")).commit());check(prefs.getStringSet("typed",null).equals(Set.of("set")));
            check(prefs.edit().putStringSet("typed",null).commit());check(!prefs.contains("typed"));
            check(prefs.edit().putInt("integer",42).putStringSet("empty",Set.of()).commit());
            check(prefs.getInt("integer",0)==42&&prefs.getStringSet("empty",null).isEmpty());
            String xml=java.nio.file.Files.readString(context.getSharedPreferencesPath("sets").toPath());check(xml.contains("persisted")&&xml.contains("integer"));
            Context device=context.createDeviceProtectedStorageContext();check(device.moveSharedPreferencesFrom(context,"sets"));
            check(device.getSharedPreferences("sets",0).getStringSet("persisted",null).equals(expected));
            check(device.deleteSharedPreferences("sets"));
        }finally{prefs.unregisterOnSharedPreferenceChangeListener(listener);}
    }
}
