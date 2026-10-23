import maclauncher.android.DynamicDex;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

public final class SharedCacheProbe {
    static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    record Child(Process process,BufferedReader output){}
    static Child start(String runtime,Path cache)throws Exception{
        var process=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),"SharedCacheProbe","child",runtime,cache.toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        var child=new Child(process,process.inputReader());
        check("ENTERING".equals(child.output.readLine()),"child reached configure");return child;
    }
    static int sessions(Path parent)throws Exception{try(var files=Files.list(parent)){return (int)files.filter(p->p.getFileName().toString().startsWith("session-")).count();}}
    static void awaitSessions(Path parent,int expected)throws Exception{long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(sessions(parent)!=expected){check(System.nanoTime()<until,"background retirement reaches the expected live-owner count");Thread.sleep(5);}}
    public static void main(String[] args)throws Exception{
        if(args[0].equals("child")){
            System.out.println("ENTERING");System.out.flush();
            Path runtime=Path.of(args[1]);DynamicDex.configure(runtime,Path.of(args[2]),runtime.resolve("android-host.jar"),SharedCacheProbe.class.getClassLoader());
            System.out.println("READY");System.out.flush();System.in.read();DynamicDex.hostShutdown();return;
        }
        Path cache=Files.createDirectories(Path.of(args[1])),parent=Files.createDirectories(cache.resolve("dynamic-dex"));
        Path old=Files.createDirectories(parent.resolve("session-1"));Files.writeString(old.resolve("owner"),Long.MAX_VALUE+"\n1970-01-01T00:00:00Z\n");
        Files.createDirectories(parent.resolve("session-2")); // construction interrupted before owner publication
        for(int i=0;i<100;i++)Files.writeString(old.resolve("classes-"+i),"obsolete");
        List<Child> children=new ArrayList<>();
        try{
            try(var channel=FileChannel.open(parent.resolve(".sessions.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);var lease=channel.lock()){
                for(int i=0;i<4;i++)children.add(start(args[0],cache));
                Thread.sleep(100);
                for(var child:children)check(child.process.isAlive()&&!child.output.ready(),"shared mutation lease must hold each constructor");
                check(Files.exists(old),"retirement waits for the shared mutation lease");
            }
            for(var child:children)check("READY".equals(child.output.readLine()),"parallel process configured successfully");
            awaitSessions(parent,4);check(sessions(parent)==4,"each live process retains its own published cache");
            children.getFirst().process.getOutputStream().close();check(children.getFirst().process.waitFor(5,TimeUnit.SECONDS),"first child exits");
            var replacement=start(args[0],cache);children.add(replacement);check("READY".equals(replacement.output.readLine()),"new process configured");
            awaitSessions(parent,4);check(sessions(parent)==4,"only the dead process cache was reclaimed");
        }finally{for(var child:children){child.process.getOutputStream().close();if(!child.process.waitFor(5,TimeUnit.SECONDS))child.process.destroyForcibly();}}
        System.out.println("PASS shared DEX cache publication, concurrent reclamation and live-owner preservation");
    }
}
