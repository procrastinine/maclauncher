package maclauncher.android.framework;

import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.jar.JarFile;
import java.util.logging.*;

public final class SystemLoaderProbe {
 public interface Service {String value();}
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void missing(ClassLoader loader,String name)throws Exception{try{loader.loadClass(name);throw new AssertionError("Missing class resolved: "+name);}catch(ClassNotFoundException expected){check(expected.getMessage().contains(name),"original missing-class identity");}}
 public static void main(String[] args)throws Exception {
  ClassLoader system=ClassLoader.getSystemClassLoader(),platform=SystemLoaderProbe.class.getClassLoader();
  check(system instanceof HostSystemClassLoader,"standard JVM custom system loader selected");
  check(system.getParent()==platform,"original host defining loader retained");
  check(HostDexFiles.bootClassLoader(null)!=system&&HostDexFiles.parent(system)==system,"mutable system delegation is never normalized to the immutable Android boot parent");
  check(system.loadClass(SystemLoaderProbe.class.getName())==SystemLoaderProbe.class,"host class identity");
  Class<?> agent=system.loadClass("loader.fixture.Agent");
  check(agent.getClassLoader()==platform&&"ready".equals(agent.getField("status").get(null)),"startup javaagent retains original host class identity");
  missing(system,"loader.fixture.ApplicationHandler");
  try(var first=new URLClassLoader(new URL[]{Path.of(args[0]).toUri().toURL()},platform);
      var second=new URLClassLoader(new URL[]{Path.of(args[2]).toUri().toURL()},platform)){
   HostContext.hostClassLoader(first);
   Class<?> handler=first.loadClass("loader.fixture.ApplicationHandler");
   check(system.loadClass(handler.getName())==handler,"system lookup returns actual application definition");
   String config="java.util.logging.MemoryHandler.target=loader.fixture.ApplicationHandler\njava.util.logging.MemoryHandler.size=1\njava.util.logging.MemoryHandler.push=ALL\n";
   LogManager.getLogManager().readConfiguration(new java.io.ByteArrayInputStream(config.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
   var memory=new MemoryHandler();try{
    memory.publish(new LogRecord(Level.SEVERE,"original MemoryHandler callback"));memory.push();
    check(handler.getField("messages").getInt(null)==1,"original JDK MemoryHandler instantiates and invokes the application Handler");
   }
   finally{memory.close();}
   check(system.getResource("loader-fixture.txt").toExternalForm().contains("application.jar"),"application resources visible");
   var inherited=Collections.list(platform.getResources("host-fixture.txt"));
   var resources=Collections.list(system.getResources("host-fixture.txt"));
   check(!inherited.isEmpty()&&resources.equals(inherited),"resource enumeration does not duplicate inherited resources");
   var services=ServiceLoader.load(Service.class,system).stream().map(ServiceLoader.Provider::get).toList();
   check(services.size()==1&&services.getFirst().getClass().getClassLoader()==first&&services.getFirst().value().equals("application"),"ServiceLoader resources and provider class identity");
   Object instrumentation=agent.getField("instrumentation").get(null);
   try(var appended=new JarFile(args[1])){((java.lang.instrument.Instrumentation)instrumentation).appendToSystemClassLoaderSearch(appended);}
   Class<?> appended=system.loadClass("loader.fixture.Appended");
   check(appended.getClassLoader()==platform&&first.loadClass(appended.getName())==appended,"instrumentation append remains visible through the application's original host parent");
   check(handler.getMethod("agentIdentity").invoke(null)==agent,"application and agent share one definition");
   // Use the real cache fact matcher without starting a conversion process.
   // A mutable system loader must recheck the actual defining hierarchy.
   maclauncher.android.DynamicDex.configure(Path.of(args[3]),Files.createDirectories(Path.of(args[4])),Path.of(args[0]),first);
   AndroidModuleProbe.verify(first,Arrays.copyOfRange(args,5,args.length));
   var current=maclauncher.android.DynamicDex.class.getDeclaredField("current");current.setAccessible(true);Object session=current.get(null);
   var header=session.getClass().getDeclaredMethod("conversionHeader",ClassLoader.class,String.class);header.setAccessible(true);
   Object resolved=header.invoke(session,system,"loader/fixture/Header");var hash=resolved.getClass().getDeclaredField("hash");hash.setAccessible(true);
   Class<?> factsType=Class.forName("maclauncher.android.DynamicDex$HeaderFacts");var copy=factsType.getDeclaredMethod("copy",Map.class);copy.setAccessible(true);
   Object facts=copy.invoke(null,Map.of("loader/fixture/Header",(byte[])hash.get(resolved)));
   var matches=factsType.getDeclaredMethod("matches",session.getClass(),ClassLoader.class);matches.setAccessible(true);
   check((Boolean)matches.invoke(facts,session,system),"current application hierarchy matches recorded DEX facts");
   missing(system,"loader.fixture.Absent");
   try{system.loadClass("loader.fixture.Broken");throw new AssertionError("Linkage failure hidden");}catch(NoClassDefFoundError expected){check(expected.getMessage().contains("MissingBase"),"genuine application linkage failure preserved");}
   HostContext.hostClassLoader(second);check(system.loadClass(handler.getName())==second.loadClass(handler.getName())&&system.loadClass(handler.getName())!=handler,"publication replaces delegation without stale class cache");
   check(!(Boolean)matches.invoke(facts,session,system),"changed application hierarchy invalidates DEX facts through the same system loader");
   maclauncher.android.DynamicDex.hostShutdown();
   HostContext.hostShutdown();missing(system,handler.getName());check(system.getResource("loader-fixture.txt")==null,"retired application resources unavailable");
   try(var loop=new URLClassLoader(new URL[0],system)){
    HostContext.hostClassLoader(loop);missing(system,"loader.fixture.LoopAbsent");
    check(system.getResource("loop-absent.txt")==null&&!system.getResources("loop-absent.txt").hasMoreElements(),"delegation cycles terminate for classes and resources");
   }finally{HostContext.hostShutdown();}
  }
  System.out.println("PASS original MemoryHandler, application identity/resources/services, publication/retirement, genuine misses/linkage and startup/dynamic instrumentation");
 }
}
