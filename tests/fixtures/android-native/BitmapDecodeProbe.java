package android.content.res;
import android.graphics.*;
import java.io.*;
import java.nio.file.*;
import java.nio.file.Path;
import java.util.*;
import java.util.zip.*;

public final class BitmapDecodeProbe {
 static int checks;static void check(boolean value){if(!value)throw new AssertionError("decode check "+checks);checks++;}
 static Bitmap decode(byte[] bytes,BitmapFactory.Options options){return BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);}
 static final class Resource extends Resources {
  final Path path;Resource(Path path){super(maclauncher.android.test.NativeResourceSupport.resources().getAssets(),maclauncher.android.test.NativeResourceSupport.resources().getDisplayMetrics(),maclauncher.android.test.NativeResourceSupport.resources().getConfiguration());this.path=path;}
  @Override public InputStream openRawResource(int id,android.util.TypedValue value){check(id==7);value.type=3;value.density=160;try{return new FileInputStream(path.toFile());}catch(IOException error){throw new UncheckedIOException(error);}}
  @Override public AssetFileDescriptor openRawResourceFd(int id){check(id==7);try{return new AssetFileDescriptor(android.os.ParcelFileDescriptor.open(path.toFile(),android.os.ParcelFileDescriptor.MODE_READ_ONLY),0,Files.size(path));}catch(IOException e){throw new UncheckedIOException(e);}}
  @Override public android.util.DisplayMetrics getDisplayMetrics(){var value=new android.util.DisplayMetrics();value.densityDpi=320;return value;}
 }
 public static void main(String[] args)throws Exception{
  maclauncher.android.test.NativeResourceSupport.resources();
  var image=new java.awt.image.BufferedImage(8,6,java.awt.image.BufferedImage.TYPE_INT_ARGB);
  for(int y=0;y<6;y++)for(int x=0;x<8;x++)image.setRGB(x,y,x<4?0xffff0000:0xff00ff00);
  var out=new ByteArrayOutputStream();check(javax.imageio.ImageIO.write(image,"png",out));byte[] bytes=out.toByteArray();image.flush();
  var options=new BitmapFactory.Options();check(options.inScaled&&options.inPremultiplied&&options.inPreferredConfig==Bitmap.Config.ARGB_8888);
  // Original BitmapFactory reports sampled bounds (8/4 x 6/4) and applies no power-of-two rounding.
  options.inJustDecodeBounds=true;options.inSampleSize=4;check(decode(bytes,options)==null&&options.outWidth==2&&options.outHeight==1&&options.outMimeType.equals("image/png"));
  options.inJustDecodeBounds=false;options.inSampleSize=3;var sampled=decode(bytes,options);check(sampled.getWidth()==2&&sampled.getHeight()==2&&!sampled.isMutable()&&sampled.getConfig()==Bitmap.Config.ARGB_8888);sampled.recycle();
  options.inSampleSize=1;options.inDensity=160;options.inTargetDensity=320;var scaled=decode(bytes,options);check(scaled.getWidth()==16&&scaled.getHeight()==12&&scaled.getDensity()==320&&options.outWidth==8);scaled.recycle();
  options.inScreenDensity=160;scaled=decode(bytes,options);check(scaled.getWidth()==8&&scaled.getDensity()==160);scaled.recycle();options.inScreenDensity=0;options.inScaled=false;
  options.inMutable=true;options.inPremultiplied=false;var mutable=decode(bytes,options);check(mutable.isMutable()&&!mutable.isPremultiplied());
  // Original Canvas rejects non-premultiplied bitmaps; mutation uses pixel access.
  mutable.setPixel(0,0,0xff0000ff);check(mutable.getPixel(0,0)==0xff0000ff);mutable.recycle();
  var reuse=Bitmap.createBitmap(16,12,Bitmap.Config.ARGB_8888);options.inBitmap=reuse;var result=decode(bytes,options);check(result==reuse&&result.getWidth()==8&&result.getHeight()==6&&result.getAllocationByteCount()==16*12*4);int[] pixel={0};result.getPixels(pixel,0,1,0,0,1,1);check(pixel[0]==0xffff0000);
  options.inBitmap=Bitmap.createBitmap(1,1,Bitmap.Config.ARGB_8888);try{decode(bytes,options);throw new AssertionError();}catch(IllegalArgumentException expected){checks++;}options.inBitmap.recycle();options.inBitmap=null;reuse.recycle();
  var input=new ByteArrayInputStream(bytes){boolean closed;@Override public void close(){closed=true;}@Override public synchronized int available(){if(closed)throw new AssertionError("caller stream closed");return super.available();}};
  var padding=new Rect();result=BitmapFactory.decodeStream(input,padding,null);check(result!=null&&padding.left==-1&&padding.bottom==-1);input.available();result.recycle();
  options=new BitmapFactory.Options();check(decode(new byte[]{1,2,3},options)==null&&options.outWidth==-1&&options.outMimeType==null);
  options.inPreferredConfig=Bitmap.Config.HARDWARE;options.inMutable=true;try{decode(bytes,options);throw new AssertionError();}catch(IllegalArgumentException expected){checks++;}
  Path file=Files.createTempFile("bitmap-decode-",".png");Path apk=Files.createTempFile("bitmap-colors-",".apk");try{
   Files.write(file,bytes);result=BitmapFactory.decodeFile(file.toString());check(result.getWidth()==8);result.recycle();
   try(var source=new FileInputStream(file.toFile())){result=BitmapFactory.decodeFileDescriptor(source.getFD(),null,null);check(result.getWidth()==8&&source.getChannel().position()==0&&source.read()==(bytes[0]&255));result.recycle();}
   options=new BitmapFactory.Options();result=BitmapFactory.decodeResource(new Resource(file),7,options);check(result.getWidth()==16&&result.getDensity()==320&&options.inDensity==160&&options.inTargetDensity==320);result.recycle();
   var value=new android.util.TypedValue();value.density=android.util.TypedValue.DENSITY_NONE;result=BitmapFactory.decodeResourceStream(new Resource(file),value,new ByteArrayInputStream(bytes),null,null);check(result.getWidth()==8);result.recycle();
   byte[] table=ResourceFixtureData.table(true,List.of(new ResourceFixtureData.Variant("","",0,0,0x1c,0xff123456,0)),"unused");
   try(var zip=new ZipOutputStream(Files.newOutputStream(apk))){zip.putNextEntry(new ZipEntry("resources.arsc"));zip.write(table);zip.closeEntry();}
   var resources=maclauncher.android.test.NativeResourceSupport.configure(apk);check(resources.getColor(0x7f010000,null)==0xff123456&&resources.getColor(0x7f010000,resources.newTheme())==0xff123456);
  }finally{maclauncher.android.framework.FrameworkResources.shutdown();Files.deleteIfExists(file);Files.deleteIfExists(apk);}
  var ids=java.util.concurrent.ConcurrentHashMap.<Integer>newKeySet();var threads=new ArrayList<Thread>();for(int n=0;n<4;n++){var thread=new Thread(()->{for(int i=0;i<2000;i++)if(!ids.add(android.view.View.generateViewId()))throw new AssertionError("duplicate ID");});threads.add(thread);thread.start();}for(var thread:threads)thread.join();check(ids.size()==8000&&ids.stream().allMatch(id->id>0&&id<=0x00ffffff));
  var counter=android.view.View.class.getDeclaredField("sNextGeneratedId");counter.setAccessible(true);((java.util.concurrent.atomic.AtomicInteger)counter.get(null)).set(0x00ffffff);check(android.view.View.generateViewId()==0x00ffffff&&android.view.View.generateViewId()==1);
  System.out.println("PASS "+checks+" bitmap option/resource/descriptor and generated-ID contracts");
 }
}
