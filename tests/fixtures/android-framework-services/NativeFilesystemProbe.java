import android.os.Environment;
import android.os.UserHandle;
import android.os.storage.StorageManager;
import maclauncher.android.framework.HostFilesystem;
import java.nio.file.*;

/** Real AOSP directory composition and volume values over owned local paths. */
public final class NativeFilesystemProbe {
    static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),files=Files.createDirectory(data.resolve("files")),cache=Files.createDirectory(data.resolve("cache"));
        HostFilesystem.configure(runtime,data,files,cache,"owned.filesystem");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        if(args.length>2)System.load(args[2]);
        check(Environment.getRootDirectory().toPath().equals(runtime.resolve("android-root/system")));
        check(Environment.getDataDirectory().toPath().equals(data)&&Environment.getDownloadCacheDirectory().toPath().equals(cache));
        check(Environment.getExternalStorageDirectory().toPath().equals(files));
        check(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).toPath().equals(files.resolve("Download")));
        check(Environment.buildExternalStorageAppFilesDirs("owned.filesystem")[0].toPath().equals(files));
        check(Environment.buildExternalStorageAppCacheDirs("owned.filesystem")[0].toPath().equals(cache));
        check(Environment.getDataUserCePackageDirectory(null,0,"owned.filesystem").toPath().equals(data));
        check(Environment.getExternalStorageState().equals("mounted")&&!Environment.isExternalStorageRemovable()&&Environment.isExternalStorageEmulated());
        check(!Environment.isExternalStorageManager()&&!Environment.isExternalStorageLegacy());
        check(Environment.getExternalStorageState(data.resolve("outside").toFile()).equals("unknown"));
        check(StorageManager.getVolumeList(UserHandle.myUserId()+1,0).length==0);
        Files.createSymbolicLink(files.resolve("outside"),cache);check(Environment.getExternalStorageState(files.resolve("outside").toFile()).equals("unknown"));
        check(HostFilesystem.mapPath("/data/../system/build.prop").equals(runtime.resolve("android-root/system/build.prop").toString()));
        check(HostFilesystem.mapPath("/data/user/0/owned.filesystem/files/file").equals(files.resolve("file").toString()));
        check(HostFilesystem.mapPath("/metadata/apex/sessions").equals(data.resolve("metadata/apex/sessions").toString()));
        check(!Path.of(HostFilesystem.mapPath("/metadata/apex/sessions")).startsWith(runtime));
        check(new String(HostFilesystem.pathBytes("/data/保存"),java.nio.charset.StandardCharsets.UTF_8).equals(data.resolve("保存").toString()));
        check(HostFilesystem.mapPath("relative").equals("relative"));
        check(Environment.isStandardDirectory("Pictures")&&!Environment.isStandardDirectory("invented"));
        System.out.println("PASS raw AOSP filesystem paths, private volume state, aliases, Unicode and symlink containment");
    }
}
