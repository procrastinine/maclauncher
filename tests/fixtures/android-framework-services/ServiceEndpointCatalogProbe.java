import android.os.IInterface;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.util.jar.JarFile;

/** Independent publisher inventory: dispatch generation must not depend on host references. */
public final class ServiceEndpointCatalogProbe {
    public static void main(String[] args)throws Exception{
        int count=0;
        try(var archive=new JarFile(Path.of(args[0]).toFile())){
            for(var entry:archive.stream().filter(value->value.getName().endsWith("$Stub.class")).toList()){
                String name=entry.getName().substring(0,entry.getName().length()-"$Stub.class".length()).replace('/','.');
                Class<?> contract=Class.forName(name,false,ServiceEndpointCatalogProbe.class.getClassLoader());
                if(!contract.isInterface()||!IInterface.class.isAssignableFrom(contract))continue;
                Class<?> stub=Class.forName(name+"$Stub",false,contract.getClassLoader());
                Class<?> generated=Class.forName("maclauncher.android.framework.endpoints."+name,false,contract.getClassLoader());
                Class<?> client=Class.forName("maclauncher.android.framework.clients."+name,false,contract.getClassLoader());
                if(generated.getSuperclass()!=stub||Modifier.isAbstract(generated.getModifiers()))throw new AssertionError("Original AIDL dispatcher lost: "+name);
                if(!contract.isAssignableFrom(client)||Modifier.isAbstract(client.getModifiers()))throw new AssertionError("Platform client contract lost: "+name);
                for(var method:contract.getMethods())if(!Modifier.isStatic(method.getModifiers())){
                    if(Modifier.isAbstract(generated.getMethod(method.getName(),method.getParameterTypes()).getModifiers()))throw new AssertionError("AIDL method has no delegate: "+method);
                    if(Modifier.isAbstract(client.getMethod(method.getName(),method.getParameterTypes()).getModifiers()))throw new AssertionError("AIDL client method has no delegate: "+method);
                }
                count++;
            }
        }
        if(count==0)throw new AssertionError("No original AIDL contracts inspected");
        System.out.println("PASS complete publisher AIDL dispatcher coverage: "+count);
    }
}
