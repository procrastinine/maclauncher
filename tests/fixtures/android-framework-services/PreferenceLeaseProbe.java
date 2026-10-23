package maclauncher.android.framework;
import android.content.SharedPreferences;
import java.io.File;
import java.nio.file.*;

public final class PreferenceLeaseProbe {
    private static SharedPreferences preferences(File file)throws Exception{
        var constructor=Class.forName("android.app.SharedPreferencesImpl").getDeclaredConstructor(File.class,int.class);constructor.setAccessible(true);
        return (SharedPreferences)constructor.newInstance(file,0);
    }
    public static void run(Path root)throws Exception{
        File file=root.resolve("original-preferences.xml").toFile(),journal=root.resolve("lease.atomic").toFile();
        String key="fixture.free.acquisition";SharedPreferences preferences=preferences(file);
        for(Boolean initial:new Boolean[]{null,false,true}){
            var editor=preferences.edit();if(initial==null)editor.remove(key);else editor.putBoolean(key,initial);if(!editor.commit())throw new AssertionError("initial commit");
            try(var lease=ProviderPreferenceLease.open(preferences,key,journal,true)){
                if(!preferences.getBoolean(key,false)||!journal.isFile())throw new AssertionError("operation not durable");
            }
            if(preferences.contains(key)!=(initial!=null)||preferences.getBoolean(key,false)!=(initial==Boolean.TRUE)||journal.exists())throw new AssertionError("exact restoration");
            ProviderPreferenceLease.open(preferences,key,journal,true); // Simulated process death: no close.
            preferences=preferences(file);
            try(var recovered=ProviderPreferenceLease.open(preferences,key,journal,false)){
                if(preferences.contains(key)!=(initial!=null)||preferences.getBoolean(key,false)!=(initial==Boolean.TRUE)||journal.exists())throw new AssertionError("recovery before publication");
            }
        }
        Files.write(journal.toPath(),new byte[]{0,0,0,2});
        try{ProviderPreferenceLease.open(preferences,key,journal,false);throw new AssertionError("invalid recovery accepted");}catch(java.io.IOException expected){}
        if(!journal.exists())throw new AssertionError("failed recovery silently discarded");
    }
}
