import android.os.FileObserver;
import maclauncher.android.framework.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

public final class FileObserverProbe {
    record Event(int flags,String name,String thread){}
    static final class Observer extends FileObserver {
        final BlockingQueue<Event> events=new LinkedBlockingQueue<>();
        Observer(Path path,int mask){super(path.toFile(),mask);}
        public void onEvent(int event,String name){events.add(new Event(event,name,Thread.currentThread().getName()));}
        Event await(int flag,String name)throws Exception{
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<until){Event e=events.poll(100,TimeUnit.MILLISECONDS);if(e!=null&&(e.flags&flag)!=0&&java.util.Objects.equals(name,e.name))return e;}
            throw new AssertionError("Missing event "+flag+" for "+name);
        }
    }
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),root=Path.of(args[1]).toRealPath(),watched=Files.createDirectory(root.resolve("watched"));
        HostFilesystem.configure(runtime,root,root.resolve("files"),root.resolve("cache"),"owned.observers");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        HostFileObserver.configure(root.toString());
        Observer all=new Observer(watched,FileObserver.ALL_EVENTS);all.startWatching();all.startWatching();
        Path original=watched.resolve("before.txt");Files.writeString(original,"one");
        Event first=all.await(FileObserver.CREATE,"before.txt");check(first.thread.equals("FileObserver"),"callback thread");
        Files.move(original,watched.resolve("é-😀.txt"),StandardCopyOption.ATOMIC_MOVE);
        all.await(FileObserver.MOVED_TO,"é-😀.txt");
        Files.delete(watched.resolve("é-😀.txt"));all.await(FileObserver.DELETE,"é-😀.txt");
        all.stopWatching();all.events.clear();Files.writeString(watched.resolve("stopped"),"x");
        check(all.events.poll(150,TimeUnit.MILLISECONDS)==null,"stop retires queued callbacks");
        all.startWatching();Files.writeString(watched.resolve("restart"),"x");all.await(FileObserver.CREATE,"restart");
        Observer absent=new Observer(root.resolve("absent"),FileObserver.CREATE);absent.startWatching();
        Files.createDirectory(root.resolve("absent"));Files.writeString(root.resolve("absent/child"),"x");
        check(absent.events.poll(100,TimeUnit.MILLISECONDS)==null,"missing path does not begin watching later");absent.stopWatching();
        Path ioRoot=Files.createDirectory(root.resolve("io"));Files.writeString(ioRoot.resolve("restart"),"x");
        Observer io=new Observer(ioRoot,FileObserver.OPEN|FileObserver.ACCESS|FileObserver.CLOSE_NOWRITE|FileObserver.CLOSE_WRITE);io.startWatching();
        Files.readString(ioRoot.resolve("restart"));io.await(FileObserver.OPEN,"restart");io.await(FileObserver.ACCESS,"restart");io.await(FileObserver.CLOSE_NOWRITE,"restart");
        try(var output=new java.io.FileOutputStream(ioRoot.resolve("closed-write").toFile())){output.write(1);io.await(FileObserver.OPEN,"closed-write");check(io.events.poll(100,TimeUnit.MILLISECONDS)==null,"writes do not invent close events");}
        io.await(FileObserver.CLOSE_WRITE,"closed-write");io.stopWatching();
        try{new Observer(root.getParent(),FileObserver.CREATE).startWatching();throw new AssertionError("outside root accepted");}catch(SecurityException expected){}
        Path link=root.resolve("escape");Files.createSymbolicLink(link,root.getParent());
        try{new Observer(link,FileObserver.CREATE).startWatching();throw new AssertionError("symlink escape accepted");}catch(SecurityException expected){}
        java.util.concurrent.atomic.AtomicInteger callbackFailures=new java.util.concurrent.atomic.AtomicInteger();
        RuntimeException exact=new RuntimeException("owned callback failure");
        Path callbackRoot=Files.createDirectory(root.resolve("callback"));
        FileObserver broken=new FileObserver(callbackRoot.toFile(),FileObserver.CREATE){public void onEvent(int e,String p){callbackFailures.incrementAndGet();throw exact;}};
        broken.startWatching();Files.writeString(callbackRoot.resolve("failure"),"x");
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(callbackFailures.get()==0&&System.nanoTime()<until)Thread.sleep(10);
        check(callbackFailures.get()>0,"failing callback executed through original dispatch");
        Files.writeString(watched.resolve("healthy"),"x");all.await(FileObserver.CREATE,"healthy");
        HostFileObserver.shutdown();HostFileObserver.shutdown();all.stopWatching();broken.stopWatching();
        check(Thread.getAllStackTraces().keySet().stream().noneMatch(t->t.isAlive()&&t.getName().equals("FileObserver")),"delivery thread retired");
        all.events.clear();all.startWatching();Files.writeString(watched.resolve("after-shutdown"),"x");check(all.events.poll(100,TimeUnit.MILLISECONDS)==null,"shutdown cannot restart native observation");
        System.out.println("PASS real file arrival, create/delete, stop/restart, scope and shutdown");
    }
}
