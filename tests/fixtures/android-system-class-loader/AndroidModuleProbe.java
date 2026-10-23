package maclauncher.android.framework;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.DynamicDex;

/** Executes the original APK filter and parcel hierarchy through demand DEX. */
public final class AndroidModuleProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static final class Loader extends ClassLoader implements AutoCloseable {
  final DynamicDex.Module module;
  Loader(Path index,Path apk,ClassLoader parent)throws IOException{super(parent);module=DynamicDex.demand(index,List.of(apk),parent,null);}
  @Override protected Class<?> findClass(String name)throws ClassNotFoundException{
   try{byte[] bytes=module.classBytes(name);if(bytes==null)throw new ClassNotFoundException(name);return defineClass(name,bytes,0,bytes.length);}
   catch(IOException failure){throw new ClassNotFoundException(name,failure);}
  }
  @Override public void close(){module.close();}
 }
 public static void verify(ClassLoader application,String[] args)throws Exception{
  if(args.length==0)return;
  ClassLoader platform=HostDexFiles.getSystemClassLoader();
  check(platform==HostDexFiles.bootClassLoader(null)&&platform!=ClassLoader.getSystemClassLoader(),"Android platform owner is independent of the JVM application system loader");
  try(var app=new Loader(Path.of(args[3]),Path.of(args[2]),application);
      var provider=new Loader(Path.of(args[1]),Path.of(args[0]),platform)){
   HostContext.hostClassLoader(app);
   String base="com.google.android.gms.common.internal.safeparcel.AbstractSafeParcelable";
   Class<?> appBase=app.loadClass(base);
   try{appBase.getDeclaredMethod("findCreator",Class.class);throw new AssertionError("original app SDK unexpectedly supplies provider creator lookup");}catch(NoSuchMethodException expected){}
   check(ClassLoader.getSystemClassLoader().loadClass(base)==appBase,"JVM system loader continues to expose the actual current application");
   Class<?> filterType=provider.loadClass("com.google.android.gms.chimera.container.FilteredClassLoader");
   ClassLoader filter=(ClassLoader)filterType.getConstructor(ClassLoader.class,Collection.class,Collection.class).newInstance(app,List.of("loader.fixture.ApplicationHandler"),List.of());
   check(filter.loadClass("loader.fixture.ApplicationHandler")==application.loadClass("loader.fixture.ApplicationHandler"),"original filter retains explicitly shared application classes");
   check(filter.loadClass("android.app.Activity")==android.app.Activity.class&&filter.loadClass("java.lang.String")==String.class,"original filter retains Android and Java platform identity");
   try{filter.loadClass(base);throw new AssertionError("original Android filter leaked an excluded application SDK class through the JVM system loader");}catch(ClassNotFoundException expected){}
   try(var module=new Loader(Path.of(args[1]),Path.of(args[0]),filter)){
    Class<?> params=Class.forName("com.google.android.gms.measurement.api.internal.InitializationParams",true,module);
    Class<?> providerBase=params.getSuperclass();
    check(providerBase!=appBase&&providerBase.getClassLoader()==module,"provider parcel hierarchy retains one defining module");
    check(providerBase.getDeclaredMethod("findCreator",Class.class).getDeclaringClass()==providerBase,"original provider supplies inherited static creator lookup");
    check(params.getField("CREATOR").get(null)!=null,"original provider InitializationParams static creator initialization succeeds");
   }
   System.out.println("PASS original Android module filter, app SDK isolation and provider parcel creator initialization");
  }finally{HostContext.hostClassLoader(application);}
 }
}
