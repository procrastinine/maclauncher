import maclauncher.android.framework.HostFilesystem;
import maclauncher.android.fixture.RuntimeFixture;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Original package metadata and the shared native/Java filesystem namespace. */
public final class FusedModulePathsProbe {
    private static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}
    private static String mapped(String text){return new String(NativeGuestPathsProbe.resolve(bytes(text),4096),StandardCharsets.UTF_8);}
    private static void equal(Object actual,Object expected){if(!Objects.equals(actual,expected))throw new AssertionError(actual+" != "+expected);}
    public static void main(String[] args)throws Exception{
        var loop=RuntimeFixture.initialize(args[0],args[1],args[2]);
        try{
            Path data=Path.of(args[1]).toRealPath(),assets=Files.createDirectories(data.resolve("assets"));
            Path base=Files.writeString(data.resolve("source.apk"),"original base ZIP"),split=Files.writeString(data.resolve("actual-feature.apk"),"original split ZIP");
            String asset="保存🍬.txt";Files.writeString(assets.resolve(asset),"actual extracted bytes");
            var info=new android.content.pm.ApplicationInfo();info.metaData=new android.os.Bundle();
            info.metaData.putString("com.android.dynamic.apk.fused.modules","base,WorldData,Feature,Existing");
            info.splitNames=new String[]{"Feature"};info.splitSourceDirs=new String[]{split.toString()};
            Path existing=Files.writeString(data.resolve("split_Existing.apk"),"real installed split");
            HostFilesystem.installNativeMappings(List.of(base,split),assets,info);
            Path fused=data.resolve("split_WorldData.apk"),feature=data.resolve("split_Feature.apk");
            for(Path alias:List.of(fused,feature)){
                Path target=alias.equals(fused)?base:split;
                equal(mapped(alias.toString()),target.toString());equal(HostFilesystem.mapPath(alias.toString()),target.toString());
                equal(new String(NativeGuestPathsProbe.read(bytes(alias.toString())),StandardCharsets.UTF_8),Files.readString(target));
                equal(mapped(alias+"/assets/"+asset),assets.resolve(asset).toString());
                equal(new String(NativeGuestPathsProbe.read(bytes(alias+"/assets/"+asset)),StandardCharsets.UTF_8),"actual extracted bytes");
                if(Files.exists(alias))throw new AssertionError("Fused module aliases must not duplicate APK files");
            }
            equal(mapped(existing.toString()),existing.toString());equal(new String(NativeGuestPathsProbe.read(bytes(existing.toString())),StandardCharsets.UTF_8),"real installed split");
            HostFilesystem.installNativeMappings(List.of(base),assets);equal(mapped(fused.toString()),fused.toString());
            System.out.println("PASS fused module APK aliases share native and Java file/asset reads without duplicate files; installed splits win and retired mappings disappear");
        }finally{maclauncher.android.framework.HostLooper.close(loop);}
        System.exit(0);
    }
}
