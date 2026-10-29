import android.os.Environment;
import android.os.UserHandle;
import android.os.storage.StorageManager;
import maclauncher.android.framework.*;
import java.nio.file.*;

/** Real AOSP directory composition and volume values over owned local paths. */
public final class NativeFilesystemProbe {
    static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),files=Files.createDirectory(data.resolve("files")),cache=Files.createDirectory(data.resolve("cache"));
        // Environment reads storage volumes through the original package and
        // storage services, so the probe prepares the application owner first.
        HostFilesystem.configure(runtime,data,files,cache,"org.example.window");
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());System.load(System.getProperty("klepton.graphics"));
        maclauncher.android.framework.HostProcessIdentity.initializeIds();JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();if(args.length>2)System.load(args[2]);HostStorageService.install();
        Path apk=Files.createDirectories(data.resolve("app")).resolve("owned.apk");maclauncher.android.fixture.PackageManifest.add(apk,"window");FrameworkResources.configure(runtime.resolve("android-framework.jar"),java.util.List.of(apk));
        HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostFilesDirectory(files.toString());HostContext.hostCacheDirectory(cache.toString());
        ClassLoader guest=new ClassLoader(NativeFilesystemProbe.class.getClassLoader()){};HostContext.hostClassLoader(guest);HostLooper.main();HostPackages.inspectSources(java.util.List.of(apk));
        HostDisplay.hostPublish(1,320,240,60);HostApplication.prepare(guest);
        android.app.Application app=new android.app.Application();HostApplication.attach(app,HostApplication.applicationContext());HostApplication.create(app);
        check(Environment.getRootDirectory().toPath().equals(runtime.resolve("android-root/system")));
        check(Environment.getDataDirectory().toPath().equals(data)&&Environment.getDownloadCacheDirectory().toPath().equals(cache));
        check(Environment.getExternalStorageDirectory().toPath().equals(files));
        check(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).toPath().equals(files.resolve("Download")));
        check(Environment.buildExternalStorageAppFilesDirs("org.example.window")[0].toPath().equals(files));
        check(Environment.buildExternalStorageAppCacheDirs("org.example.window")[0].toPath().equals(cache));
        check(Environment.getDataUserCePackageDirectory(null,0,"org.example.window").toPath().equals(data));
        check(Environment.getExternalStorageState().equals("mounted")&&!Environment.isExternalStorageRemovable()&&Environment.isExternalStorageEmulated());
        check(!Environment.isExternalStorageManager()&&!Environment.isExternalStorageLegacy());
        check(Environment.getExternalStorageState(data.resolve("outside").toFile()).equals("unknown"));
        check(StorageManager.getVolumeList(UserHandle.myUserId()+1,0).length==0);
        Files.createSymbolicLink(files.resolve("outside"),cache);check(Environment.getExternalStorageState(files.resolve("outside").toFile()).equals("unknown"));
        check(HostFilesystem.mapPath("/data/../system/build.prop").equals(runtime.resolve("android-root/system/build.prop").toString()));
        String privateFile=HostFilesystem.mapPath("/data/user/0/org.example.window/files/file");if(!privateFile.equals(files.resolve("file").toString()))throw new AssertionError("private files mapping "+privateFile);
        check(HostFilesystem.mapPath("/metadata/apex/sessions").equals(runtime.resolve("android-root/metadata/apex/sessions").toString()));
        check(!Path.of(HostFilesystem.mapPath("/metadata/apex/sessions")).startsWith(data));
        check(new String(HostFilesystem.pathBytes("/data/保存"),java.nio.charset.StandardCharsets.UTF_8).equals(data.resolve("保存").toString()));
        check(HostFilesystem.mapPath("relative").equals("relative"));
        check(Environment.isStandardDirectory("Pictures")&&!Environment.isStandardDirectory("invented"));
        System.out.println("PASS raw AOSP filesystem paths, private volume state, aliases, Unicode and symlink containment");System.exit(0);
    }
}
