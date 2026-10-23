public final class NativePropertyOwnerProbe {
    private static native long find(String name);
    private static native int read(long handle);
    private static native boolean sameOwner(long handle,int index);
    public static void main(String[] args){
        System.load(args[0]);long[] handles=new long[512];
        for(int i=0;i<handles.length;++i){
            handles[i]=find("fixture."+i);
            if(handles[i]==0||!sameOwner(handles[i],i)||read(handles[i])!=1000+i)throw new AssertionError("Property owner identity changed: "+i);
        }
        for(int i=0;i<handles.length;++i)if(read(handles[i])!=1000+i||find("fixture."+i)!=handles[i])throw new AssertionError("Borrowed handle changed");
        if(find("missing")!=0)throw new AssertionError("Missing property");
        System.out.println("PASS original property owner identity and void read ABI across512 distinct borrowed handles");
    }
}
