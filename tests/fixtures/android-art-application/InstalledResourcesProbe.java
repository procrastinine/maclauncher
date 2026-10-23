import android.content.res.ApkAssets;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.util.DisplayMetrics;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;

/** Real unprivileged Bionic/ApkAssets and separate original package resource contexts. */
public final class InstalledResourcesProbe {
    public static void main(String[] args)throws Exception{
        String[] expected={"first package","second package"};
        for(int i=0;i<2;i++){
            try(AssetManager assets=new AssetManager.Builder().addApkAssets(ApkAssets.loadFromPath(args[i])).build()){
                DisplayMetrics metrics=new DisplayMetrics();metrics.setToDefaults();Configuration configuration=new Configuration();configuration.setToDefaults();
                Resources resources=new Resources(assets,metrics,configuration);
                if(!expected[i].equals(resources.getString(0x7f010000)))throw new AssertionError("Package resource context differs");
            }
            try{Files.write(Paths.get(args[i]),new byte[]{0},StandardOpenOption.APPEND);throw new AssertionError("Enrolled peer code is writable");}
            catch(java.io.IOException expectedFailure){}
        }
        try{Files.readAllBytes(Paths.get(args[2]));throw new AssertionError("Peer private data became visible");}
        catch(java.io.IOException expectedFailure){}
        for(int i=3;i<args.length;i++){
            if(!"enrolled code bytes".equals(new String(Files.readAllBytes(Paths.get(args[i])),java.nio.charset.StandardCharsets.UTF_8)))throw new AssertionError("Enrolled code bytes differ");
            android.system.StructStat stat=android.system.Os.stat(args[i]);
            if(stat.st_uid!=0||stat.st_gid!=0||(stat.st_mode&07777)!=0644)throw new AssertionError("Enrolled code identity differs");
            try{Files.write(Paths.get(args[i]),new byte[]{0},StandardOpenOption.APPEND);throw new AssertionError("Enrolled code alias is writable");}
            catch(java.io.IOException expectedFailure){}
        }
        new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out)).println("PASS original ART multi-package ApkAssets/Resources, read-only code and hidden peer data");
    }
}
