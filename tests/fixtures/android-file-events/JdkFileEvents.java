import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.nio.channels.*;
import java.util.concurrent.*;
import android.os.FileObserver;
import android.system.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

public final class JdkFileEvents {
 static final int UID=10047;
 record Event(int flags,String name){}
 static final class Observer extends FileObserver {
  final BlockingQueue<Event> events=new LinkedBlockingQueue<>();
  Observer(Path path){super(path.toFile(),OPEN|ACCESS|CLOSE_WRITE|CLOSE_NOWRITE|CREATE);}
  public void onEvent(int flags,String name){events.add(new Event(flags,name));}
  void await(int wanted,String name)throws Exception{
   long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
   while(System.nanoTime()<end){Event e=events.poll(100,TimeUnit.MILLISECONDS);if(e!=null&&(e.flags&wanted)!=0&&java.util.Objects.equals(e.name,name))return;}
   throw new AssertionError("Missing event "+wanted+" "+name);
  }
 }
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void owner(Path path,boolean link)throws Exception{
  StructStat value=link?Os.lstat(path.toString()):Os.stat(path.toString());
  check(value.st_uid==UID&&value.st_gid==UID,"Original libcore inode owner: "+path);
  LinkOption[] options=link?new LinkOption[]{LinkOption.NOFOLLOW_LINKS}:new LinkOption[0];
  check(((Number)Files.getAttribute(path,"unix:uid",options)).intValue()==value.st_uid&&
        ((Number)Files.getAttribute(path,"unix:gid",options)).intValue()==value.st_gid,
        "Original NIO and libcore ownership agree: "+path);
 }
 interface Action{void run()throws Exception;}
 static void denied(Action action)throws Exception{
  try{action.run();throw new AssertionError("Ownership metadata mutation accepted");}
  catch(ErrnoException expected){check(expected.errno==OsConstants.EPERM,"Protected ownership errno");}
 }
 static void deniedOpen(Action action)throws Exception{
  try{action.run();throw new AssertionError("Stream opened without Android inode permission");}
  catch(FileNotFoundException expected){}
 }
 static void deniedNio(Action action)throws Exception{
  try{action.run();throw new AssertionError("Foreign NIO ownership mutation accepted");}
  catch(java.nio.file.FileSystemException expected){check(expected.getReason()!=null&&expected.getReason().toLowerCase(java.util.Locale.ROOT).contains("permi"),"Protected NIO ownership errno");}
 }
 public static void main(String[]args)throws Exception{
  RuntimeFixture.initialize(args[0],args[1]);
  HostProcessIdentity.configure(UID,(int)new com.sun.security.auth.module.UnixSystem().getUid());
  Path data=Path.of(args[1]).toRealPath();HostFileObserver.configure(data.toString());
  Path root=Files.createDirectory(data.resolve("watched"));owner(root,false);
  Observer watch=new Observer(root);watch.startWatching();
  System.out.println("BEGIN original file operations");
  try{
   Path stream=root.resolve("stream");
   try(FileOutputStream out=new FileOutputStream(stream.toFile())){out.write(7);watch.await(FileObserver.OPEN,"stream");}
   watch.await(FileObserver.CLOSE_WRITE,"stream");owner(stream,false);
   try(FileInputStream in=new FileInputStream(stream.toFile())){check(in.read()==7,"Stream content");watch.await(FileObserver.OPEN,"stream");watch.await(FileObserver.ACCESS,"stream");}watch.await(FileObserver.CLOSE_NOWRITE,"stream");
   try(RandomAccessFile file=new RandomAccessFile(root.resolve("random").toFile(),"rw")){file.write(8);watch.await(FileObserver.OPEN,"random");}watch.await(FileObserver.CLOSE_WRITE,"random");owner(root.resolve("random"),false);
   Os.chmod(stream.toString(),0000);
   try{
    deniedOpen(()->{try(FileInputStream in=new FileInputStream(stream.toFile())){}});
    deniedOpen(()->{try(FileOutputStream out=new FileOutputStream(stream.toFile())){}});
    deniedOpen(()->{try(FileOutputStream out=new FileOutputStream(stream.toFile(),true)){}});
    for(String mode:new String[]{"r","rw","rwd","rws"})deniedOpen(()->{try(RandomAccessFile file=new RandomAccessFile(stream.toFile(),mode)){}});
   }finally{Os.chmod(stream.toString(),0600);}
   check(java.util.Arrays.equals(Files.readAllBytes(stream),new byte[]{7}),"Denied truncate retains payload");
   FileDescriptor descriptor;
   try(FileOutputStream out=new FileOutputStream(stream.toFile(),true)){descriptor=out.getFD();out.getChannel().position(0);out.write(8);}
   check(!descriptor.valid(),"Original stream close retires descriptor");
   check(java.util.Arrays.equals(Files.readAllBytes(stream),new byte[]{7,8}),"Append survives channel seek");
   for(String mode:new String[]{"rwd","rws"})try(RandomAccessFile file=new RandomAccessFile(stream.toFile(),mode)){file.seek(1);file.write(9);}
   try(FileInputStream in=new FileInputStream(stream.toFile())){check(in.read()==7&&in.read()==9,"Synchronous random access preserves content");}
   try(FileChannel channel=FileChannel.open(root.resolve("channel"),StandardOpenOption.CREATE,StandardOpenOption.WRITE)){channel.write(ByteBuffer.wrap(new byte[]{9}));watch.await(FileObserver.OPEN,"channel");}watch.await(FileObserver.CLOSE_WRITE,"channel");owner(root.resolve("channel"),false);
   try(FileChannel channel=FileChannel.open(root.resolve("channel"),StandardOpenOption.READ)){channel.read(ByteBuffer.allocate(1));watch.await(FileObserver.OPEN,"channel");watch.await(FileObserver.ACCESS,"channel");}watch.await(FileObserver.CLOSE_NOWRITE,"channel");
   Path directory=root.resolve("file-directory");check(directory.toFile().mkdir(),"File.mkdir");watch.await(FileObserver.CREATE,"file-directory");owner(directory,false);
   Path nio=Files.createDirectory(root.resolve("nio-directory"));watch.await(FileObserver.CREATE,"nio-directory");owner(nio,false);
   Path link=Files.createSymbolicLink(root.resolve("nio-link"),Path.of("stream"));watch.await(FileObserver.CREATE,"nio-link");owner(link,true);owner(link,false);
   Files.setAttribute(stream,"unix:uid",UID);Files.setAttribute(stream,"unix:gid",UID);owner(stream,false);
   Os.chown(stream.toString(),UID,UID);owner(stream,false);
   denied(()->Os.chown(stream.toString(),UID+1,-1));
   deniedNio(()->Files.setAttribute(stream,"unix:uid",UID+1));
   owner(stream,false);
  }finally{watch.stopWatching();HostFileObserver.shutdown();HostApplication.shutdown();FrameworkResources.shutdown();}
  System.out.println("PASS original JDK stream, random access, NIO and inode ownership through full runtime");System.exit(0);
 }
}
