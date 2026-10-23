public final class PresentationTransitionProbe {
    private static native void run(String angle,int[] first,int[] last);
    private static int[] image(int[] corners){
        int[] pixels=new int[64*48];
        for(int y=0;y<48;y++)for(int x=0;x<64;x++)pixels[y*64+x]=corners[(y<24?0:2)+(x<32?0:1)];
        return pixels;
    }
    public static void main(String[] args){
        System.load(args[0]);
        run(args[1],image(new int[]{0xffff0000,0xff00ff00,0xff0000ff,0xffffff00}),
            image(new int[]{0xff0000ff,0xffff0000,0xffffff00,0xff00ff00}));
        System.out.println("PASS one actual presenter Canvas -> EGL -> Canvas output pixels and retirement");
    }
}
