import java.net.*;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicInteger;
public final class VerifySuper {
    public static void main(String[] args)throws Exception {
        try(var loader=new URLClassLoader(new URL[]{Path.of(args[0]).toUri().toURL(),Path.of(args[1]).toUri().toURL()},ClassLoader.getPlatformClassLoader())){
            Class<?> calls=Class.forName("app.Calls",true,loader);AtomicInteger count=new AtomicInteger();
            Object result=calls.getMethod("apply",Runnable.class).invoke(calls.getConstructor().newInstance(),(Runnable)count::incrementAndGet);
            if(!result.equals(42)||count.get()!=1)throw new AssertionError("Original interface default call did not execute");
        }
        System.out.println("PASS converted external interface super receiver");
    }
}
