package com.maclauncher.android.arguments;

import java.lang.instrument.*;
import java.security.ProtectionDomain;
import java.util.concurrent.atomic.AtomicBoolean;
import jdk.internal.org.objectweb.asm.*;

/** Adapt the initial owned entry binding while retaining all original APIs. */
public final class ArgumentsAgent implements Opcodes {
    private static final String BRIDGE="com/maclauncher/android/arguments/ArgumentsBridge";
    public static void premain(String provider,Instrumentation instrumentation)throws Exception{
        if(System.getenv("MACLAUNCHER_GAME_ARGUMENTS")==null)return;
        String target="macapk".equals(provider)?"com/macapk/loader/ActivityHost":"maclauncher/android/Host";
        // Package tools inherit environment settings but do not load Android.
        if(ClassLoader.getSystemClassLoader().getResource(target+".class")==null)return;
        AtomicBoolean transformed=new AtomicBoolean();
        instrumentation.addTransformer(new ClassFileTransformer(){
            @Override public byte[] transform(ClassLoader loader,String name,Class<?> prior,ProtectionDomain domain,byte[] bytes){
                if(!target.equals(name))return null;
                try {
                    ClassReader reader=new ClassReader(bytes);ClassWriter writer=new ClassWriter(reader,ClassWriter.COMPUTE_MAXS);int[] bindings={0};
                    reader.accept(new ClassVisitor(ASM8,writer){
                        @Override public MethodVisitor visitMethod(int access,String method,String descriptor,String signature,String[] exceptions){
                            MethodVisitor original=super.visitMethod(access,method,descriptor,signature,exceptions);
                            if(target.equals("com/macapk/loader/ActivityHost")){
                                if(!method.equals("macapkSetLauncherIntent")||!descriptor.equals("(Landroid/content/Intent;)V"))return original;
                                bindings[0]++;
                                return new MethodVisitor(ASM8,original){@Override public void visitCode(){super.visitCode();super.visitVarInsn(ALOAD,0);super.visitMethodInsn(INVOKESTATIC,BRIDGE,"intent","(Ljava/lang/Object;)V",false);}};
                            }
                            return new MethodVisitor(ASM8,original){
                                @Override public void visitMethodInsn(int operation,String owner,String name,String signature,boolean face){
                                    if(operation==INVOKESTATIC&&owner.equals("maclauncher/android/framework/HostActivity")&&name.equals("attach")&&signature.equals("(Landroid/app/Activity;Landroid/content/Context;Landroid/app/Application;Landroid/content/pm/ActivityInfo;)V")){
                                        bindings[0]++;super.visitMethodInsn(INVOKESTATIC,BRIDGE,"attach","(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)V",false);
                                    }else super.visitMethodInsn(operation,owner,name,signature,face);
                                }
                            };
                        }
                    },0);
                    if(bindings[0]!=1)throw new IllegalStateException("Android initial activity binding differs from the selected runtime");
                    transformed.set(true);return writer.toByteArray();
                }catch(Throwable failure){System.err.println("Android launch arguments could not be attached to the initial activity.");Runtime.getRuntime().halt(78);return null;}
            }
        });
        Class.forName(target.replace('/','.'),false,ClassLoader.getSystemClassLoader());
        if(!transformed.get())throw new IllegalStateException("Android initial activity binding is unavailable");
    }
}
