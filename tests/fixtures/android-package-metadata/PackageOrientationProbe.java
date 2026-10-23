package maclauncher.android;

import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.PackageMetadata;
import maclauncher.android.framework.HostActivity;
import android.content.pm.ActivityInfo;

public final class PackageOrientationProbe {
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),root=Path.of(args[1]);
        RuntimeBootstrap.initialize(runtime,root,Files.createDirectories(root.resolve("files")),Files.createDirectories(root.resolve("cache")),"fixture.orientation",false,false,false);
        PackageMetadata.initialize(runtime);
        var result=PackageMetadata.read(List.of(Path.of(args[2])),root.resolve("cache"),"en-US",root.resolve("icon.png"));
        var activities=result.getJSONObject("activityWindows");
        if(!activities.getJSONObject("org.maclauncher.metadata.fixture.Main").isNull("landscape"))throw new AssertionError(result);
        var info=new ActivityInfo();
        info.screenOrientation=ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
        var portrait=HostActivity.initialWindowSize(info,1280,800);
        if(!Boolean.FALSE.equals(HostActivity.initialWindowLandscape(info))||portrait.x!=800||portrait.y!=1280)throw new AssertionError("Original fixed portrait policy was not retained");
        info.screenOrientation=ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
        var landscape=HostActivity.initialWindowSize(info,800,1280);
        if(!Boolean.TRUE.equals(HostActivity.initialWindowLandscape(info))||landscape.x!=1280||landscape.y!=800)throw new AssertionError("Original fixed landscape policy was not retained");
        info.screenOrientation=ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR;
        if(HostActivity.initialWindowLandscape(info)!=null)throw new AssertionError("An unconstrained orientation was forced");
        System.out.println("PASS original parsed fixed orientation before application callbacks");
    }
}
