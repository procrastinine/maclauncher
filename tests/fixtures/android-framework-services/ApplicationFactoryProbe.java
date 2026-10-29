package maclauncher.android.framework;
import android.app.*;
import android.content.*;
import android.content.pm.ApplicationInfo;
import android.content.pm.ActivityInfo;
import android.os.Looper;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.LocalProviders;

/** Original Instrumentation/AppComponentFactory runs beneath both VM entries. */
public final class ApplicationFactoryProbe {
 private static int constructed,attached,factoryCalls,created,classLoaderCalls;
 private static LocalProviders providers;
 private static ClassLoader expectedLoader;
 private static boolean substituteLoader,overridePackage;
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static final class Declared extends Application {public Declared(){throw new AssertionError("Original AppComponentFactory was bypassed");}}
 public static final class DeclaredActivity extends Activity {public DeclaredActivity(){throw new AssertionError("Original Activity factory was bypassed");}}
 public static final class ReplacementActivity extends Activity {}
 public static final class Replacement extends Application {
  public Replacement(){constructed++;}
  @Override protected void attachBaseContext(Context context){attached++;super.attachBaseContext(context);}
  @Override public String getPackageName(){return overridePackage?"fixture.context.wrapper":super.getPackageName();}
  @Override public void onCreate(){check(getContentResolver()!=null&&HostServices.manager().asBinder()!=null,"Original application context exists before onCreate");created++;}
 }
 public static final class Factory extends AppComponentFactory {
  static {
   try{check(java.security.KeyStore.getInstance("AndroidKeyStore").getProvider().getName().equals("AndroidKeyStore"),"Original KeyStore provider exists before component factory initialization");}
   catch(java.security.KeyStoreException failure){throw new AssertionError("Original KeyStore provider is unavailable during component factory initialization",failure);}
   ActivityThread thread=ActivityThread.currentActivityThread();
   check(thread!=null,"Original ActivityThread exists before component factory initialization");
   Object bind=HostUiAccess.get(thread,ActivityThread.class,"mBoundApplication");
   check(bind!=null,"Original process bind record exists before component factory initialization");
   LoadedApk apk=(LoadedApk)HostUiAccess.get(bind,bind.getClass(),"info");
   check(apk!=null&&apk.getApplicationInfo().packageName.equals("org.example.permissions"),"Original LoadedApk is published before component factory initialization");
   Context context=(Context)HostUiAccess.call(HostUiAccess.method(HostUiAccess.type("android.app.ContextImpl"),"createAppContext",ActivityThread.class,LoadedApk.class),null,thread,apk);
   try{check(context.getPackageName().equals("org.example.permissions")&&context.getPackageManager().getApplicationInfo(context.getPackageName(),0).sourceDir.equals(apk.getApplicationInfo().sourceDir),"Original early component factory can resolve its bound package context");}
   catch(android.content.pm.PackageManager.NameNotFoundException failure){throw new AssertionError("Original bound package is unavailable during component factory initialization",failure);}
  }
  @Override public ClassLoader instantiateClassLoader(ClassLoader base,ApplicationInfo info){
   classLoaderCalls++;check(base==expectedLoader&&info.packageName.equals("org.example.permissions"),"Factory receives the prepared VM loader and original package");
   if(substituteLoader)expectedLoader=new ClassLoader(base){};
   return expectedLoader;
  }
  @Override public Application instantiateApplication(ClassLoader loader,String name)throws InstantiationException,IllegalAccessException,ClassNotFoundException{
   factoryCalls++;check(loader==expectedLoader,"Factory receives the VM's actual application loader");
   if(name.equals("fixture.failure"))throw new ClassNotFoundException("factory-sentinel");
   check(name.equals(Declared.class.getName())||name.equals(Application.class.getName()),"Original class identity reaches the factory");return new Replacement();
  }
  // Activities resolve their manifest declaration first, so the failure uses a declared component.
  static boolean failActivity;
  @Override public Activity instantiateActivity(ClassLoader loader,String name,Intent intent)throws InstantiationException,IllegalAccessException,ClassNotFoundException{
   check(loader==expectedLoader&&intent.getAction().equals(Intent.ACTION_MAIN)&&intent.hasCategory(Intent.CATEGORY_LAUNCHER),"Original Activity factory receives the loader and launcher Intent");
   if(failActivity){failActivity=false;throw new ClassNotFoundException("activity-factory-sentinel");}
   check(intent.getComponent().getClassName().equals(name)&&name.equals(DeclaredActivity.class.getName()),"Original Activity component identity reaches the factory");return new ReplacementActivity();
  }
 }
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]),files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache")),apk=Path.of(args[3]);
  var bootstrap=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);bootstrap.setAccessible(true);bootstrap.invoke(null,runtime,data,files,cache,"org.example.permissions",false,false,false);
  try(var authority=(maclauncher.android.ProcessAuthority)HostUiAccess.call(HostUiAccess.method(maclauncher.android.ProcessAuthority.class,"read",int.class,String.class,String.class),null,5,"org.example.permissions","org.example.permissions")){
  Object identity=HostUiAccess.get(authority,maclauncher.android.ProcessAuthority.class,"self");
  HostProcessIdentity.configure((int)HostUiAccess.call(HostUiAccess.method(identity.getClass(),"uid"),identity),(int)HostUiAccess.call(HostUiAccess.method(identity.getClass(),"hostUid"),identity));HostLooper.main();HostUiAccess.call(HostUiAccess.method(maclauncher.android.ProcessAuthority.class,"attachPlatform"),authority);
  System.load(System.getProperty("klepton.graphics"));
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostContext.hostPackage("org.example.permissions","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),runtime.resolve("native").toString(),35);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);Looper loop=HostLooper.main();HostPackages.inspectSources(List.of(apk));
  ApplicationInfo info=HostContext.hostApplicationInfoSnapshot();info.appComponentFactory=Factory.class.getName();HostContext.adoptApplicationInfo(info,info.metaData);
  var originalTypeface=android.graphics.Typeface.DEFAULT;
  HostDisplay.hostPublish(1,320,240,60);HostStorageService.install();expectedLoader=ApplicationFactoryProbe.class.getClassLoader();substituteLoader=args[2].equals("loader");overridePackage=args[2].equals("context");HostApplication.prepare(expectedLoader);
  check(classLoaderCalls==1&&HostApplication.current().apk.getClassLoader()==expectedLoader,"Original factory publishes its application class loader exactly once");
  check(originalTypeface!=null&&android.graphics.Typeface.DEFAULT==originalTypeface,"Application bind retains the existing original font map");
  if(args[2].equals("partial")){
   int[] callbacks={0};HostLooper.addShutdownListener(loop,()->callbacks[0]++);
   var constructor=Class.forName("maclauncher.android.ArtActivity").getDeclaredConstructor(String.class,double[].class,org.json.JSONObject.class,Class.forName("maclauncher.android.ProcessAuthority"));constructor.setAccessible(true);
   try{constructor.newInstance(null,null,new org.json.JSONObject(),null);throw new AssertionError("Partial ART constructor failure was swallowed");}
   catch(java.lang.reflect.InvocationTargetException failure){if(!(failure.getCause() instanceof org.json.JSONException)||failure.getCause().getSuppressed().length!=0){failure.getCause().printStackTrace();throw new AssertionError("Original startup failure remains primary without cleanup failures");}}
   check(callbacks[0]==1,"Partial ART startup retires the shared callbacks");
   try{HostApplication.current();throw new AssertionError("Partial ART startup retained its application owner");}catch(IllegalStateException expected){}
   check(HostContextServices.retireApplication(null,null)==null&&HostContextServices.retireContext(null,loop)==null,"Partial retirement is idempotent");HostLooper.close(loop);
   System.out.println("PASS original application factory partial, shared cleanup and original failure identity");return;
  }
  try{
   try{HostApplication.instantiate(expectedLoader,"fixture.failure");throw new AssertionError("Original factory exception was swallowed");}catch(ClassNotFoundException expected){check(expected.getMessage().equals("factory-sentinel"),"Factory exception retains identity");}
   Application app=HostApplication.instantiate(expectedLoader,args[2].equals("default")?null:Declared.class.getName());
   check(app instanceof Replacement&&constructed==1&&attached==1&&factoryCalls==2,"Original factory redirects, constructs and attaches exactly once");
   check(app.getBaseContext()==HostApplication.applicationContext()&&app.getApplicationContext()==app,"Original ContextImpl retains the adopted application");
   Factory.failActivity=true;try{HostActivity.instantiate(expectedLoader,DeclaredActivity.class.getName());throw new AssertionError("Activity factory exception was swallowed");}catch(ClassNotFoundException expected){check(expected.getMessage().equals("activity-factory-sentinel"),"Activity factory exception retains identity");}
   Activity substituted=HostActivity.instantiate(expectedLoader,DeclaredActivity.class.getName());check(substituted instanceof ReplacementActivity,"Original Activity factory substitution retained");
   ActivityInfo component=new ActivityInfo();component.name=DeclaredActivity.class.getName();component.packageName=app.getApplicationInfo().packageName;component.applicationInfo=app.getApplicationInfo();
   ActivityInfo other=new ActivityInfo(component);other.packageName="another.application";
   try{HostActivity.attach(substituted,HostApplication.applicationContext(),app,other);throw new AssertionError("Foreign component attachment accepted");}catch(SecurityException expected){}
   HostActivity.attach(substituted,overridePackage?app:HostApplication.applicationContext(),app,component);
   check(!overridePackage||!app.getPackageName().equals(component.packageName),"Activity attachment accepts an overridden Context package while retaining the manifest identity");
   check(substituted.getComponentName().getClassName().equals(DeclaredActivity.class.getName()),"Factory substitution keeps its originally resolved component");HostActivity.finish(substituted);
   try{HostApplication.instantiate(expectedLoader,Declared.class.getName());throw new AssertionError("Application was instantiated twice");}catch(IllegalStateException expected){}
   providers=new LocalProviders();HostContextServices.applicationCreated(app,loop);
   try(var lease=HostContextServices.installProviders(app,List.of(),providers,false)){HostApplication.create(app);check(created==1,"Original onCreate invoked once after provider publication");}
   android.widget.EditText editor=new android.widget.EditText(app);editor.setText("Android");
   check(editor.getPaint().measureText(editor.getText().toString())>0,"Original EditText uses the published native font map");
   System.out.println("PASS original application factory "+args[2]+", exception identity, provider ordering and one attach");
  }finally{
   RuntimeException primary=new RuntimeException("owner-first"),late=new RuntimeException("callback-cleanup");
   HostLooper.addShutdownListener(loop,()->{throw late;});
   Throwable failure=HostContextServices.retireApplication(primary,providers);check(failure==primary,"Shared retirement preserves the original owner failure");
   failure=HostContextServices.retireContext(failure,loop,()->{try{FrameworkResources.frameworkPath();throw new AssertionError("Loader retired before framework resource metadata");}catch(IllegalStateException expected){}});
   check(failure==primary&&primary.getSuppressed().length==1&&primary.getSuppressed()[0]==late,"Callback cleanup is suppressed on the original owner failure");
   try{HostApplication.current();throw new AssertionError("Application owner survived retirement");}catch(IllegalStateException expected){}
   check(HostContextServices.retireApplication(null,providers)==null&&HostContextServices.retireContext(null,loop)==null,"Repeated shared retirement is idempotent");
   HostLooper.close(loop);
  }
  }finally{HostRemoteServices.shutdown();}
 }
}
