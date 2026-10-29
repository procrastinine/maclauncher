import android.content.res.*;
import android.util.TypedValue;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import maclauncher.android.framework.*;

/** Original AOSP resources and native storage; only the tiny APK is fixture-owned. */
public final class NativeResourcesProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),apk=data.resolve("assets.apk");
        maclauncher.android.framework.HostFilesystem.configure(runtime,data,data,data,"owned.resources");
        byte[] content="An owned Android asset".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try(var zip=new ZipOutputStream(Files.newOutputStream(apk))){
            var entry=new ZipEntry("assets/message.txt");var crc=new CRC32();crc.update(content);
            entry.setMethod(ZipEntry.STORED);entry.setSize(content.length);entry.setCompressedSize(content.length);entry.setCrc(crc.getValue());
            zip.putNextEntry(entry);zip.write(content);zip.closeEntry();
        }
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));
        System.load(runtime.resolve("native/libnativebinding.dylib").toString());maclauncher.android.framework.HostProcessIdentity.initializeIds();
        maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));
        maclauncher.android.framework.JvmNativeMemory.initialize();
        Path splitA=data.resolve("a.apk"),splitB=data.resolve("b.apk");
        for(Path split:List.of(splitA,splitB))try(var zip=new ZipOutputStream(Files.newOutputStream(split))){zip.putNextEntry(new ZipEntry("assets/"+split.getFileName()));zip.closeEntry();}
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk,splitB,splitA));
        // PackageParser sorts installed splits after the initial resource owner exists.
        // Keep its prior Resources alive: ResourcesManager still updates that owner.
        Resources prior=android.app.ResourcesManager.getInstance().getResources(null,apk.toString(),new String[]{splitB.toString(),splitA.toString()},null,null,null,null,null,CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO,NativeResourcesProbe.class.getClassLoader(),null);
        Path alias=data.resolve("installed-source-alias");Files.createSymbolicLink(alias,data);
        var parsed=new android.content.pm.ApplicationInfo();parsed.sourceDir=alias.resolve(apk.getFileName()).toString();parsed.splitSourceDirs=new String[]{alias.resolve(splitA.getFileName()).toString(),alias.resolve(splitB.getFileName()).toString()};parsed.splitNames=new String[]{"a","b"};
        var adopt=FrameworkResources.class.getDeclaredMethod("adoptPackageSources",android.content.pm.ApplicationInfo.class);adopt.setAccessible(true);adopt.invoke(null,parsed);
        maclauncher.android.framework.HostContext.hostPackage("owned.resources","1",1);
        maclauncher.android.framework.HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),35);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);var owner=HostLooper.main();HostStorageService.install();HostApplication.prepare(NativeResourcesProbe.class.getClassLoader());
        try{
            Resources resources=HostApplication.applicationContext().getResources();
            var installedInfo=HostApplication.applicationContext().getApplicationInfo();check(installedInfo.sourceDir.equals(parsed.sourceDir)&&Arrays.equals(installedInfo.splitSourceDirs,parsed.splitSourceDirs));
            check(resources.getResourceName(android.R.string.ok).equals("android:string/ok"));
            check(!resources.getString(android.R.string.ok).isEmpty());
            check(resources.getStringArray(android.R.array.phoneTypes).length>0);
            try(var stream=resources.getAssets().open("message.txt")){check(Arrays.equals(content,stream.readAllBytes()));}
            Resources.Theme theme=resources.newTheme();theme.applyStyle(android.R.style.Theme_Material_Light,true);
            try(var values=theme.obtainStyledAttributes(new int[]{android.R.attr.windowActionBar})){check(values.hasValue(0)&&values.getBoolean(0,false));}
            theme.applyStyle(android.R.style.Theme_Material_Light_NoActionBar,true);
            try(var values=theme.obtainStyledAttributes(new int[]{android.R.attr.windowActionBar})){check(values.hasValue(0)&&!values.getBoolean(0,true));}
            TypedValue value=new TypedValue();check(theme.resolveAttribute(android.R.attr.windowActionBar,value,true)&&value.data==0);
            try(var xml=resources.getLayout(android.R.layout.simple_list_item_1)){
                int tags=0;for(int event=xml.next();event!=org.xmlpull.v1.XmlPullParser.END_DOCUMENT;event=xml.next())if(event==org.xmlpull.v1.XmlPullParser.START_TAG)tags++;
                check(tags>0);
            }
            var requested=new Configuration();requested.setLocale(Locale.FRENCH);requested.fontScale=1.25f;
            var alternate=HostApplication.applicationContext().createConfigurationContext(requested).getResources();
            check(alternate.getConfiguration().getLocales().get(0).equals(Locale.FRENCH));
            check(alternate.getConfiguration().fontScale==1.25f&&resources.getConfiguration().fontScale==1f);
            maclauncher.android.framework.HostDisplay.hostPublish(1,640,480,60);
            check(prior.getConfiguration().screenWidthDp==640&&prior.getConfiguration().screenHeightDp==480);
            try(var stream=prior.getAssets().open("message.txt")){check(Arrays.equals(content,stream.readAllBytes()));}
            check(resources.getConfiguration().screenWidthDp==640&&resources.getConfiguration().screenHeightDp==480);
            check(alternate.getConfiguration().getLocales().get(0).equals(Locale.FRENCH)&&alternate.getConfiguration().fontScale==1.25f);
        }finally{HostApplication.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();HostLooper.close(owner);FrameworkResources.shutdown();FrameworkResources.shutdown();}
        check(prior.getResourceName(android.R.string.ok).equals("android:string/ok"));
        try(var stream=prior.getAssets().open("message.txt")){check(Arrays.equals(content,stream.readAllBytes()));}
        var adapters=new ArrayList<Class<?>>();adapters.add(FrameworkResources.class);Collections.addAll(adapters,FrameworkResources.class.getDeclaredClasses());
        for(Class<?> adapter:adapters)for(var field:adapter.getDeclaredFields())check(!Resources.class.isAssignableFrom(field.getType())&&!AssetManager.class.isAssignableFrom(field.getType()));
        System.out.println("PASS original AOSP resources: assets, framework identity, inherited themes, typed attributes, compiled XML, split reordering, canonical source identity with retained alias spelling and shared configuration ownership");
    }
}
