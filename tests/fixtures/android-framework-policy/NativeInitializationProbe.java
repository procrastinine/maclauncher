import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import maclauncher.android.framework.JvmNativeMemory;

/** Unnamed future native owners use the same registration ordering as current owners. */
public final class NativeInitializationProbe implements Opcodes {
    static byte[] source(String name,boolean helper,boolean nativeDependency){
        ClassWriter out=new ClassWriter(ClassWriter.COMPUTE_MAXS|ClassWriter.COMPUTE_FRAMES);
        out.visit(V21,ACC_PUBLIC,name,null,"java/lang/Object",null);
        out.visitField(ACC_PUBLIC|ACC_STATIC|ACC_FINAL,"value","I",null,null).visitEnd();
        out.visitMethod(ACC_PRIVATE|ACC_STATIC|ACC_NATIVE,"platform","()V",null,null).visitEnd();
        MethodVisitor init=out.visitMethod(ACC_STATIC,"<clinit>","()V",null,null);init.visitCode();
        if(helper)init.visitMethodInsn(INVOKESTATIC,name,"helper","()V",false);
        else if(nativeDependency)conditionalNative(init,name);
        init.visitIntInsn(BIPUSH,42);init.visitFieldInsn(PUTSTATIC,name,"value","I");
        init.visitInsn(RETURN);init.visitMaxs(0,0);init.visitEnd();
        if(helper){MethodVisitor method=out.visitMethod(ACC_PRIVATE|ACC_STATIC,"helper","()V",null,null);method.visitCode();conditionalNative(method,name);method.visitInsn(RETURN);method.visitMaxs(0,0);method.visitEnd();}
        out.visitEnd();return out.toByteArray();
    }
    static void conditionalNative(MethodVisitor method,String owner){Label skip=new Label();method.visitInsn(ICONST_0);method.visitJumpInsn(IFEQ,skip);method.visitMethodInsn(INVOKESTATIC,owner,"platform","()V",false);method.visitLabel(skip);}
    static byte[] consumer(){ClassWriter out=new ClassWriter(ClassWriter.COMPUTE_MAXS);out.visit(V21,ACC_PUBLIC,"future/Consumer",null,"java/lang/Object",null);out.visitField(ACC_PUBLIC|ACC_STATIC|ACC_FINAL,"value","I",null,null).visitEnd();MethodVisitor init=out.visitMethod(ACC_STATIC,"<clinit>","()V",null,null);init.visitCode();init.visitFieldInsn(GETSTATIC,"future/Holder","value","I");init.visitFieldInsn(PUTSTATIC,"future/Consumer","value","I");init.visitInsn(RETURN);init.visitMaxs(0,0);init.visitEnd();out.visitEnd();return out.toByteArray();}
    static final class Loader extends ClassLoader {Class<?> add(String name,byte[] bytes){return defineClass(name.replace('/','.'),bytes,0,bytes.length);}}
    static void state(String name,Object value)throws Exception{Field field=JvmNativeMemory.class.getDeclaredField(name);field.setAccessible(true);field.set(null,value);}
    static Object state(String name)throws Exception{Field field=JvmNativeMemory.class.getDeclaredField(name);field.setAccessible(true);return field.get(null);}
    static void check(boolean okay,String message){if(!okay)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        byte[] plain=source("future/Plain",false,false);check(GraphicsPortability.transform("future/Plain.class",plain)==plain,"pure Java initialization remains unchanged");
        Loader loader=new Loader();List<Class<?>> classes=new ArrayList<>();
        state("registering",true);
        for(boolean helper:new boolean[]{false,true}){
            String name="future/Native"+(helper?"Helper":"Direct");byte[] original=source(name,helper,true),adapted=GraphicsPortability.transform(name+".class",original);
            ClassNode node=new ClassNode();new ClassReader(adapted).accept(node,0);
            check(node.methods.stream().anyMatch(method->method.name.equals("hostInitializeNatives")),"new native owner discovered without class list");
            Class<?> type=loader.add(name,adapted);Class.forName(type.getName(),true,loader);classes.add(type);
            check(type.getField("value").getInt(null)==0,"native-dependent body waits for registration");
        }
        check(((Set<?>)state("pendingInitializers")).size()==2,"actual class initialization derives pending owners");
        state("registered",true);
        for(Class<?> type:classes){JvmNativeMemory.initializeClass(type);check(type.getField("value").getInt(null)==42,"full original initializer runs after registration");}
        String name="future/LateNative";Class<?> late=loader.add(name,GraphicsPortability.transform(name+".class",source(name,false,true)));
        check(late.getField("value").getInt(null)==42,"classes first used later initialize immediately");
        // A parent must wait too: returning an uninitialized holder would expose
        // null/zero fields to its unchanged constructor and static algorithms.
        Path archive=Files.createTempFile("initializer-dependencies-",".jar");byte[] holder=source("future/Holder",false,true);
        try{
            try(var zip=new ZipOutputStream(Files.newOutputStream(archive))){zip.putNextEntry(new ZipEntry("future/Holder.class"));zip.write(holder);zip.closeEntry();}
            try(var zip=new ZipFile(archive.toFile())){
                GraphicsPortability.initialize(zip);state("registered",false);((Set<?>)state("pendingInitializers")).clear();
                Loader dependent=new Loader();dependent.add("future/Holder",GraphicsPortability.transform("future/Holder.class",holder));
                Class<?> consumer=dependent.add("future/Consumer",GraphicsPortability.transform("future/Consumer.class",consumer()));
                Class.forName(consumer.getName(),true,dependent);check(((Set<?>)state("pendingInitializers")).equals(Set.of(consumer)),"static-field dependency defers the parent before its holder is touched");
                state("registered",true);JvmNativeMemory.initializeClass(consumer);check(consumer.getField("value").getInt(null)==42,"transitive holder initializes before the original parent reads it");
                ClassNode contract=new ClassNode();new ClassReader(consumer()).accept(contract,0);contract.name="future/Contract";contract.access|=ACC_INTERFACE|ACC_ABSTRACT;
                for(MethodNode method:contract.methods)for(AbstractInsnNode instruction:method.instructions)if(instruction instanceof FieldInsnNode field&&field.owner.equals("future/Consumer"))field.owner=contract.name;
                ClassWriter writer=new ClassWriter(0);contract.accept(writer);byte[] originalInterface=writer.toByteArray();
                byte[] adaptedInterface=GraphicsPortability.transform(contract.name+".class",originalInterface);
                ClassNode result=new ClassNode();new ClassReader(adaptedInterface).accept(result,0);
                check(result.fields.stream().allMatch(field->(field.access&(ACC_PUBLIC|ACC_STATIC|ACC_FINAL))==(ACC_PUBLIC|ACC_STATIC|ACC_FINAL)),"interface fields retain required final modifiers");
                check(result.methods.stream().noneMatch(method->method.name.equals("hostInitializeNatives")),"interface final stores remain in original initializer");
                Class<?> api=dependent.add(contract.name,adaptedInterface);check(api.isInterface()&&api.getField("value").getInt(null)==42,"native-dependent interface verifies and retains actual initialized value");
            }
        }finally{Files.deleteIfExists(archive);}
        System.out.println("PASS derived native initializer registration and lazy class initialization");
    }
}
