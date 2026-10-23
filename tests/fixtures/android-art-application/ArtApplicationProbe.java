import java.io.*;
import android.os.*;
import android.content.res.*;
import android.graphics.*;
import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.util.DisplayMetrics;
import dalvik.system.PathClassLoader;
import java.lang.reflect.*;
public final class ArtApplicationProbe {
 private static native long window(boolean open,int width,int height);
 private static int backingWidth,backingHeight;
 private static void set(Object owner,Class<?> type,String name,Object value)throws Exception{Field f=type.getDeclaredField(name);f.setAccessible(true);f.set(owner,value);}
 private static Object construct(Class<?> type,Class<?>[] types,Object...values)throws Exception{Constructor<?> c=type.getDeclaredConstructor(types);c.setAccessible(true);return c.newInstance(values);}
 private static Object call(Object owner,Class<?> type,String name,Class<?>[] types,Object...values)throws Exception{Method m=type.getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(owner,values);}
 private static void application(String path,PrintWriter out)throws Exception{
  DisplayMetrics metrics=new DisplayMetrics();metrics.setToDefaults();metrics.densityDpi=320;metrics.density=2;metrics.widthPixels=backingWidth;metrics.heightPixels=backingHeight;
  var parsed=maclauncher.android.framework.PackageParsing.parse(java.nio.file.Path.of(path),0,metrics);
  ApplicationInfo info=((com.android.internal.pm.parsing.pkg.AndroidPackageHidden)parsed).toAppInfoWithoutState();info.uid=android.os.Process.myUid();info.sourceDir=info.publicSourceDir=path;
  info.dataDir="/data/user/0/"+info.packageName;info.credentialProtectedDataDir=info.dataDir;info.deviceProtectedDataDir=info.dataDir;
  new File(info.dataDir).mkdirs();
  ClassLoader loader=new PathClassLoader(path,ArtApplicationProbe.class.getClassLoader());
  ActivityThread thread=(ActivityThread)construct(ActivityThread.class,new Class<?>[0]);
  set(null,ActivityThread.class,"sCurrentActivityThread",thread);
  Class<?> controller=Class.forName("android.app.ConfigurationController");Object configuration=construct(controller,new Class<?>[]{Class.forName("android.app.ActivityThreadInternal")},thread);
  Configuration cfg=new Configuration(Resources.getSystem().getConfiguration());cfg.setToDefaults();cfg.densityDpi=320;
  call(configuration,controller,"setConfiguration",new Class<?>[]{Configuration.class},cfg);call(configuration,controller,"setCompatConfiguration",new Class<?>[]{Configuration.class},cfg);
  set(thread,ActivityThread.class,"mConfigurationController",configuration);
  Instrumentation instrumentation=new Instrumentation();call(instrumentation,Instrumentation.class,"basicInit",new Class<?>[]{ActivityThread.class},thread);set(thread,ActivityThread.class,"mInstrumentation",instrumentation);
  LoadedApk apk=new LoadedApk(thread,info,CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO,loader,false,true,false);
  set(apk,LoadedApk.class,"mClassLoader",loader);set(apk,LoadedApk.class,"mDefaultClassLoader",loader);
  set(null,ServiceManager.class,"sServiceManager",maclauncher.android.framework.HostServices.manager());
  Class<?> impl=Class.forName("android.app.ContextImpl");Context context=(Context)call(null,impl,"createAppContext",new Class<?>[]{ActivityThread.class,LoadedApk.class},thread,apk);
  out.println("original LoadedApk ContextImpl resources");out.flush();
  Application app=instrumentation.newApplication(loader,info.className,context);
  call(context,impl,"setOuterContext",new Class<?>[]{Context.class},app);set(thread,ActivityThread.class,"mInitialApplication",app);set(apk,LoadedApk.class,"mApplication",app);
  instrumentation.callApplicationOnCreate(app);
  if(loader.loadClass(info.className).getField("starts").getInt(null)!=1)throw new AssertionError("Application callback");
  if(!new File(context.getFilesDir(),"created.txt").isFile())throw new AssertionError("private storage");
  out.println("original APK Application lifecycle, assets, resources, private files passed");out.flush();
 }
 public static void main(String[] args) throws Exception {
  try(PrintWriter out=new PrintWriter(new FileOutputStream(args[0]))) {
   try {
    out.println("main pid="+android.os.Process.myPid());out.flush();
    Looper.prepareMainLooper();
    Parcel parcel=Parcel.obtain();parcel.writeString("original guest Parcel");parcel.setDataPosition(0);
    if(!"original guest Parcel".equals(parcel.readString()))throw new AssertionError("Parcel");parcel.recycle();
    out.println("looper and Parcel");out.flush();
    try(AssetManager assets=new AssetManager()) {
     int cookie=assets.addAssetPath("/system/framework/framework-res.apk");if(cookie==0)throw new AssertionError("framework assets");
     try(XmlResourceParser xml=assets.openXmlResourceParser(cookie,"AndroidManifest.xml")){int type;while((type=xml.next())!=org.xmlpull.v1.XmlPullParser.START_TAG&&type!=org.xmlpull.v1.XmlPullParser.END_DOCUMENT){}if(!"manifest".equals(xml.getName()))throw new AssertionError("manifest parser");}
    }
    out.println("original framework resources");out.flush();
    Bitmap bitmap=Bitmap.createBitmap(16,16,Bitmap.Config.ARGB_8888);bitmap.eraseColor(0xff23ab47);if(bitmap.getPixel(3,3)!=0xff23ab47)throw new AssertionError("original bitmap");bitmap.recycle();
    System.load(args[2]);long extent=window(true,640,400);backingWidth=(int)(extent>>>32);backingHeight=(int)extent;
    try{if(backingWidth<1||backingHeight<1)throw new AssertionError("committed native extent");out.println("shared Mac hidden window committed "+backingWidth+"x"+backingHeight);out.flush();application(args[1],out);}finally{window(false,0,0);}
    out.println("shared Mac window reverse release");
    out.println("ART original app bootstrap + assets + bitmap passed");
   }catch(Throwable failure){failure.printStackTrace(out);out.flush();System.exit(1);}
  }
 }
}
