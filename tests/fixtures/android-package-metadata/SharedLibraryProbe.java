package maclauncher.android.framework;

import android.app.LoadedApk;
import android.content.pm.*;
import android.content.res.CompatibilityInfo;
import android.os.*;
import com.android.internal.pm.parsing.pkg.ParsedPackage;
import com.android.server.SystemConfig;
import com.android.server.pm.PackageSetting;
import dalvik.system.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Original parser, package state, policy and class-loader integration; no game process. */
public final class SharedLibraryProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static ClassLoader[] before(ClassLoader loader){return (ClassLoader[])HostUiAccess.get(loader,BaseDexClassLoader.class,"sharedLibraryLoaders");}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=Path.of(args[2]);
        var loop=RuntimeFixture.initialize(args[0],args[1]);
        try{
            FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
            HostUiAccess.set(null,ServiceManager.class,"sServiceManager",HostServices.manager());
            var configuration=HostPermissions.platformConfiguration();
            Path framework=runtime.resolve("android-framework.jar"),declaration=data.resolve("platform-library.xml");
            Files.writeString(declaration,Files.readString(Path.of(args[3])).replace("/system/framework/org.apache.http.legacy.jar",framework.toString()));
            HostDexFiles.installed(framework,List.of(framework));
            HostUiAccess.call(HostUiAccess.method(SystemConfig.class,"readPermissionsFromXml",org.xmlpull.v1.XmlPullParser.class,java.io.File.class,int.class),
                configuration,android.util.Xml.newPullParser(),declaration.toFile(),-1);
            var original=configuration.getSharedLibraries().get("org.apache.http.legacy");
            check(original!=null&&!original.isNative,"original platform HTTP declaration");
            Path empty=data.resolve("dependency.jar");try(var output=new java.util.jar.JarOutputStream(Files.newOutputStream(empty))){
                output.putNextEntry(new java.util.jar.JarEntry("META-INF/maclauncher/parent-classes"));
                var metadata=new java.io.DataOutputStream(output);metadata.writeInt(1);metadata.writeInt(0);output.closeEntry();
            }
            HostDexFiles.installed(empty,List.of(empty));
            configuration.getSharedLibraries().put("fixture.library",new SystemConfig.SharedLibraryEntry("fixture.library",empty.toString(),new String[]{original.name},false));
            ParsedPackage parsed=HostPackageParser.parseSources(List.of(apk),data.resolve("cache"));
            ((com.android.internal.pm.pkg.parsing.ParsingPackage)parsed).addUsesOptionalLibrary("fixture.library").addUsesOptionalLibrary("fixture.absent");
            HostContext.hostPackage(parsed.getPackageName(),"1",1);
            HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),parsed.getTargetSdkVersion());
            Object installation=HostUiAccess.construct(HostUiAccess.type("maclauncher.android.framework.HostPackages$Installation"),
                new Class<?>[]{ParsedPackage.class,Path.class,String.class,int.class,long.class,long.class},
                parsed,data,data.toString(),android.os.Process.myUid(),1L,2L);
            PackageSetting state=(PackageSetting)HostUiAccess.get(installation,installation.getClass(),"packageState");
            ApplicationInfo info=(ApplicationInfo)HostUiAccess.call(HostUiAccess.method(installation.getClass(),"app",long.class,int.class),installation,(long)PackageManager.GET_SHARED_LIBRARY_FILES,UserHandle.myUserId());
            check(info.sharedLibraryInfos.size()==1&&info.sharedLibraryInfos.getFirst().getName().equals("fixture.library"),"original launch ApplicationInfo has selected optional library");
            check(info.sharedLibraryInfos.getFirst().getDependencies().getFirst().getName().equals(original.name),"original SystemConfig dependency graph");
            check(state.getUsesLibraryFiles().contains(original.filename),"original package state keeps dependency paths");
            var loaded=new LoadedApk(null,info,CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO,null,false,true,false);
            ClassLoader parent=HostDexFiles.parent(SharedLibraryProbe.class.getClassLoader());
            var first=new PathClassLoader("",data.toString(),parent);var second=new PathClassLoader("",data.toString(),parent);
            HostSharedLibraries.bind(loaded,first);HostSharedLibraries.bind(loaded,second);
            check(before(first).length==1&&before(first)[0]==before(second)[0],"original LoadedApk/ApplicationLoaders canonical library owner");
            check(before(before(first)[0]).length==1,"original recursive library loader");
            check(Class.forName("org.apache.http.impl.client.DefaultHttpClient",false,first)==Class.forName("org.apache.http.impl.client.DefaultHttpClient"),"existing original framework code remains visible");
            ParsedPackage old=HostPackageParser.parseSources(List.of(apk),data.resolve("cache"));((com.android.internal.pm.pkg.parsing.ParsingPackage)old).setTargetSdkVersion(27);HostSharedLibraries.prepare(old,false);
            check(old.getUsesLibraries().contains(original.name),"original old-target compatibility policy");
            ParsedPackage modern=HostPackageParser.parseSources(List.of(apk),data.resolve("cache"));((com.android.internal.pm.pkg.parsing.ParsingPackage)modern).setTargetSdkVersion(36);HostSharedLibraries.prepare(modern,false);
            check(!modern.getUsesLibraries().contains(original.name),"modern apps do not acquire implicit HTTP");
            HostPackages.inspectSources(List.of(apk));
            check(Arrays.asList(HostPackages.service().getSystemSharedLibraryNames()).contains(original.name),"original package API reports installed library declarations");
            System.out.println("PASS original optional libraries, dependency graph, canonical loaders, API visibility and target policy");
        }finally{HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();}
        System.exit(0);
    }
}
