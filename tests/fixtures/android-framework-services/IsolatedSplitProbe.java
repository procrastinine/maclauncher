package maclauncher.android.framework;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.DynamicDex;
import maclauncher.android.LocalProviders;

/** Real signed DEX APKs through original LoadedApk split dependencies and ContextImpl resources. */
public final class IsolatedSplitProbe {
    private static final String PACKAGE="fixture.isolated";
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void hidden(ClassLoader loader,String name)throws Exception{
        try{loader.loadClass(PACKAGE+"."+name);throw new AssertionError("Isolated loader exposed "+name+": "+loader);}
        catch(ClassNotFoundException expected){}
    }
    private static String resources(Context context){
        var values=new ArrayList<String>();
        for(String name:List.of("base_value","parent_value","child_value","sibling_value")){
            int id=context.getResources().getIdentifier(name,"string",PACKAGE);
            values.add(id==0?"":context.getString(id));
        }
        return String.join("|",values);
    }
    private static void context(Context context,String expected,String... assets)throws Exception{
        check(resources(context).equals(expected),"Split resources "+context.getClassLoader()+": "+resources(context));
        Set<String> wanted=Set.of(assets);
        for(String name:List.of("base","parent","child","sibling")){
            boolean found;
            try(var input=context.getAssets().open("owned-isolated-"+name+".txt")){check(new String(input.readAllBytes()).equals(name),"asset contents");found=true;}
            catch(java.io.FileNotFoundException absent){found=false;}
            check(found==wanted.contains(name),"Split asset isolation: "+context.getClassLoader()+" / "+name);
        }
    }
    private static void reported(String component,ClassLoader loader,String expected){
        check(System.getProperty("fixture.isolated."+component+".loader").equals(Integer.toString(System.identityHashCode(loader))),component+" context loader");
        check(System.getProperty("fixture.isolated."+component+".resources").equals(expected),component+" split resources");
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath(),converted=Path.of(args[2]);
        List<Path> sources=Arrays.stream(args).skip(3).map(Path::of).toList();
        var loop=maclauncher.android.fixture.RuntimeFixture.initialize(runtime.toString(),data.toString());
        LocalProviders providers=new LocalProviders();AutoCloseable providerLease=null;
        try{
            HostContext.hostPackage(PACKAGE,"1",1);
            HostContext.hostApplicationInfo(true,sources.getFirst().toString(),data.toString(),data.toString(),36);
            HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
            FrameworkResources.configure(runtime.resolve("android-framework.jar"),sources);
            var inspected=HostPackages.inspectSources(sources);
            ApplicationInfo info=HostContext.hostApplicationInfoSnapshot();
            check(info.requestsIsolatedSplitLoading(),"Original parser retained isolation");
            check(info.splitDependencies!=null&&info.splitDependencies.size()==4,"Original dependency graph");
            check(Arrays.equals(info.splitNames,new String[]{"feature.child","feature.parent","feature.sibling"}),"Original sorted split names");
            HostFilesystem.installNativeMappings(sources,Files.createDirectories(data.resolve("assets")),info);
            ClassLoader base=HostDexFiles.application(converted,sources,data,IsolatedSplitProbe.class.getClassLoader(),true);
            HostContext.hostClassLoader(base);DynamicDex.configure(runtime,data.resolve("cache"),converted,base);
            HostApplication.prepare(base);
            Application application=HostApplication.instantiate(base,PACKAGE+".BaseApplication");
            HostApplication.create(application);
            Context parent=application.createContextForSplit("feature.parent");
            Context child=application.createContextForSplit("feature.child");
            Context sibling=application.createContextForSplit("feature.sibling");
            check(application.getClassLoader()==base,"Original base application loader");
            check(child.getClassLoader().getParent()==parent.getClassLoader(),"Child uses declared feature parent");
            check(parent.getClassLoader().getParent()==base&&sibling.getClassLoader().getParent()==base,"Independent features use base parent");
            check((int)child.getClassLoader().loadClass(PACKAGE+".ChildType").getMethod("answer").invoke(null)==12,"DEX feature code executes through parent dependency");
            check(child.getClassLoader().loadClass(PACKAGE+".ParentType").getClassLoader()==parent.getClassLoader(),"Parent class defining identity");
            check(child.getClassLoader().loadClass(PACKAGE+".BaseType").getClassLoader()==base,"Base class defining identity");
            for(String name:List.of("ParentType","ChildType","SiblingType"))hidden(base,name);
            hidden(parent.getClassLoader(),"ChildType");hidden(parent.getClassLoader(),"SiblingType");
            hidden(child.getClassLoader(),"SiblingType");hidden(sibling.getClassLoader(),"ParentType");hidden(sibling.getClassLoader(),"ChildType");
            Class<?> parentPrivate=parent.getClassLoader().loadClass(PACKAGE+".PrivateValue"),siblingPrivate=sibling.getClassLoader().loadClass(PACKAGE+".PrivateValue");
            check(parentPrivate!=siblingPrivate,"Sibling private definitions have distinct class identity");
            check((int)parentPrivate.getMethod("answer").invoke(null)==21,"First sibling retains its own private body");
            check((int)siblingPrivate.getMethod("answer").invoke(null)==84,"Second sibling executes its own per-APK private body");
            hidden(base,"PrivateValue");
            context(application,"base-resource|||","base");
            context(parent,"base-resource|parent-resource||","base","parent");
            context(child,"base-resource|parent-resource|child-resource|","base","parent","child");
            context(sibling,"base-resource|||sibling-resource","base","sibling");
            Activity activity=HostActivity.instantiate(base,PACKAGE+".ChildActivity");
            check(activity.getClass().getClassLoader()==child.getClassLoader(),"Initial Activity factory uses split loader");
            var activityInfo=HostPackages.activityInfo(PACKAGE+".ChildActivity");
            context(HostApplication.activityContext(activityInfo,new android.os.Binder()),"base-resource|parent-resource|child-resource|","base","parent","child");
            application.startService(new Intent().setComponent(new ComponentName(PACKAGE,PACKAGE+".ParentService")));
            HostLooper.drain(loop);
            reported("service",parent.getClassLoader(),"base-resource|parent-resource||");
            providerLease=HostContextServices.installProviders(application,inspected,providers,false);
            reported("provider",child.getClassLoader(),"base-resource|parent-resource|child-resource|");
            application.sendBroadcast(new Intent(PACKAGE+".RECEIVE").setPackage(PACKAGE));
            HostLooper.drain(loop);
            reported("receiver",child.getClassLoader(),"base-resource|parent-resource|child-resource|");
            System.out.println("PASS original isolated split loaders, parent dependency, sibling isolation, resources and Activity/Service/Provider/Receiver routing");
        }finally{
            if(providerLease!=null)providerLease.close();
            Throwable failure=HostContextServices.retireApplication(null,providers);
            try{DynamicDex.hostShutdown();HostDexFiles.clearInstalled();FrameworkResources.shutdown();HostLooper.close(loop);}
            catch(Throwable cleanup){if(failure==null)failure=cleanup;else failure.addSuppressed(cleanup);}
            if(failure!=null)HostUiAccess.raise(failure);
        }
    }
}
