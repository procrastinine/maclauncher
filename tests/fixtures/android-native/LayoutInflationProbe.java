package android.content.res;
import android.app.*;import android.content.*;import android.view.*;import android.widget.*;import android.util.*;
import java.util.*;import java.nio.file.*;import java.util.zip.*;import java.io.*;
import static android.content.res.ResourceFixtureData.*;

/** Actual compiled XML bytes, typed constructors, geometry and lifecycle callbacks. */
public final class LayoutInflationProbe {
 static int checks;static void ok(boolean value,String why){checks++;if(!value)throw new AssertionError(why);}
 static final String NS="http://schemas.android.com/apk/res/android";
 static final int HEADER=android.R.id.title,BODY=android.R.id.custom,CENTER=android.R.id.icon,FRAGMENT=android.R.id.content;
 record A(String name,int id,int type,int value,String text){}
 record N(String name,List<A> attrs,List<N> children){}
 static A a(String n,int id,int type,int value){return new A(n,id,type,value,null);}static A s(String n,int id,String value){return new A(n,id,3,0,value);}
 static A dim(String name,int id,int px){return a(name,id,px<0?0x10:5,px<0?px:px<<8);}
 static N n(String name,List<A> attrs,N...children){return new N(name,attrs,List.of(children));}
 static List<A> size(int w,int h,A...extra){var out=new ArrayList<A>();out.add(dim("layout_width",0x010100f4,w));out.add(dim("layout_height",0x010100f5,h));out.addAll(List.of(extra));return out;}
 static byte[] xml(N root){var strings=new ArrayList<String>();strings.add(NS);collect(root,strings);int[] map=new int[strings.size()];ids(root,strings,map);var output=new ByteArrayOutputStream();output.writeBytes(pool(true,strings.toArray(new String[0])));var resource=buffer(map.length*4);for(int id:map)resource.putInt(id);output.writeBytes(chunk(0x180,8,resource.array()));emit(root,strings,output);return chunk(3,8,output.toByteArray());}
 static void add(List<String> strings,String s){if(!strings.contains(s))strings.add(s);}static void collect(N n,List<String>s){add(s,n.name);for(A a:n.attrs){add(s,a.name);if(a.text!=null)add(s,a.text);}for(N child:n.children)collect(child,s);}
 static void ids(N n,List<String>s,int[]ids){for(A a:n.attrs)ids[s.indexOf(a.name)]=a.id;for(N child:n.children)ids(child,s,ids);}
 static void emit(N n,List<String>s,ByteArrayOutputStream out){
  // Compiled XML attributes follow resource-ID order, as emitted by AAPT.
  var attrs=new ArrayList<>(n.attrs);attrs.sort(Comparator.comparingInt(A::id));int id=0,clazz=0;
  for(int i=0;i<attrs.size();i++){A a=attrs.get(i);if(a.id==android.R.attr.id)id=i+1;if(a.id==0&&a.name.equals("class"))clazz=i+1;}
  var start=buffer(28+attrs.size()*20);start.putInt(12).putInt(-1).putInt(-1).putInt(s.indexOf(n.name)).putShort((short)20).putShort((short)20).putShort((short)attrs.size()).putShort((short)id).putShort((short)clazz).putShort((short)0);
  for(A a:attrs)start.putInt(a.id==0?-1:0).putInt(s.indexOf(a.name)).putInt(a.text==null?-1:s.indexOf(a.text)).putShort((short)8).put((byte)0).put((byte)a.type).putInt(a.type==3?s.indexOf(a.text):a.value);
  out.writeBytes(chunk(0x102,16,start.array()));for(N child:n.children)emit(child,s,out);out.writeBytes(chunk(0x103,16,buffer(16).putInt(12).putInt(-1).putInt(-1).putInt(s.indexOf(n.name)).array()));
 }
 static XmlResourceParser parse(byte[] xml){try(var block=new XmlBlock(xml)){return block.newParser();}}
 public static final class Custom extends View {
  static int finishes;public Custom(Context c,AttributeSet a){super(c,a);ok(a.getAttributeResourceValue(NS,"id",0)==BODY,"custom typed attributes");}
  @Override protected void onFinishInflate(){super.onFinishInflate();finishes++;}
 }
 public static final class Part extends Fragment {
  static final List<String> calls=new ArrayList<>();void log(String value){calls.add(value);}
  @Override public void onAttach(Activity activity){super.onAttach(activity);log("attach");}
  @Override public void onCreate(android.os.Bundle state){super.onCreate(state);log("create");}
  @Override public View onCreateView(LayoutInflater inflater,ViewGroup parent,android.os.Bundle state){log("view");View view=new View(inflater.getContext());view.setPadding(3,4,5,6);return view;}
  @Override public void onViewCreated(View view,android.os.Bundle state){super.onViewCreated(view,state);log("viewCreated");}
  @Override public void onStart(){super.onStart();log("start");}
  @Override public void onResume(){super.onResume();log("resume");}
  @Override public void onPause(){log("pause");super.onPause();}
  @Override public void onStop(){log("stop");super.onStop();}
  @Override public void onDestroyView(){log("destroyView");super.onDestroyView();}
  @Override public void onDestroy(){log("destroy");super.onDestroy();}
  @Override public void onDetach(){log("detach");super.onDetach();}
 }
 private static View inflate(Context context,N root,ViewGroup parent,boolean attach){try(var parser=parse(xml(root))){return LayoutInflater.from(context).inflate(parser,parent,attach);}}
 private static void measure(View root,int width,int height){root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));root.layout(0,0,width,height);}
 public static void run(Context context)throws Exception{
  N header=n("View",size(-1,30,a("id",0x010100d0,1,HEADER),a("layout_alignParentTop",0x0101018c,0x12,1)));
  N body=n("view",size(-1,-1,s("class",0,Custom.class.getName()),a("id",0x010100d0,1,BODY),a("layout_below",0x01010185,1,HEADER)));
  N center=n("View",size(20,10,a("id",0x010100d0,1,CENTER),a("layout_centerInParent",0x0101018f,0x12,1)));
  N description=n("RelativeLayout",size(-1,-1),body,center,header);Custom.finishes=0;
  RelativeLayout root=(RelativeLayout)inflate(context,description,null,false);measure(root,200,120);View view=root.findViewById(BODY);
  ok(view.getTop()==30&&view.getHeight()==90&&view.getWidth()==200,"original forward sibling constraint");ok(root.findViewById(CENTER).getLeft()==90&&root.findViewById(CENTER).getTop()==55,"original centering");ok(Custom.finishes==1,"inflation callback once");
  measure(root,300,200);ok(view.getHeight()==170&&view.getWidth()==300,"original measurement after resize");
  var headerParams=(RelativeLayout.LayoutParams)root.findViewById(HEADER).getLayoutParams();headerParams.addRule(RelativeLayout.BELOW,BODY);root.requestLayout();fails(()->measure(root,300,200),IllegalStateException.class);headerParams.removeRule(RelativeLayout.BELOW);
  byte[] bytes=xml(description);try(var parser=parse(bytes)){int event;do{event=parser.next();}while(event!=XmlResourceParser.START_TAG&&event!=XmlResourceParser.END_DOCUMENT);ok(event==XmlResourceParser.START_TAG,"compiled layout has a root element");ok(parser.getAttributeCount()==2&&parser.getAttributeNameResource(0)==0x010100f4,"compiled attribute resource IDs");ok(parser.getAttributeIntValue(NS,"layout_width",0)==-1,"signed layout value");}
  N merge=n("merge",List.of(),n("View",size(4,7)));fails(()->inflate(context,merge,null,false),InflateException.class);FrameLayout parent=new FrameLayout(context);ok(inflate(context,merge,parent,true)==parent&&parent.getChildCount()==1,"original merge attachment");
  TextView text=(TextView)inflate(context,n("TextView",size(-2,-2,s("text",0x0101014f,"Actual text"))),parent,false);text.measure(View.MeasureSpec.makeMeasureSpec(200,View.MeasureSpec.AT_MOST),View.MeasureSpec.makeMeasureSpec(100,View.MeasureSpec.AT_MOST));ok(text.getMeasuredWidth()>20&&text.getMeasuredHeight()>5&&text.getParent()==null,"native text measurement and unattached inflation");
 }
 public static Part fragments(Activity activity){
  Part.calls.clear();N fragment=n("fragment",size(20,10,s("name",0x01010003,Part.class.getName()),a("id",0x010100d0,1,FRAGMENT)));
  View root=inflate(activity,n("FrameLayout",size(-1,-1),fragment),null,false);activity.addContentView(root,new ViewGroup.LayoutParams(-1,-1));
  Part part=(Part)activity.getFragmentManager().findFragmentById(FRAGMENT);ok(part!=null&&part.isResumed()&&part.getView().getPaddingLeft()==3,"original XML fragment lifecycle");
  activity.getFragmentManager().beginTransaction().hide(part).commit();activity.getFragmentManager().executePendingTransactions();ok(part.isHidden()&&part.getView().getVisibility()==View.GONE,"queued fragment hide");
  activity.getFragmentManager().beginTransaction().show(part).commitNow();ok(!part.isHidden()&&part.getView().getVisibility()==View.VISIBLE,"fragment show");
  // XML fragments are recreated by layout inflation. Transaction attachment
  // recreates the view of a programmatic fragment in its retained container.
  int container=View.generateViewId();root.setId(container);part=new Part();activity.getFragmentManager().beginTransaction().add(container,part).commitNow();
  ok(part.isResumed()&&part.getView().getParent()==root,"programmatic fragment container and lifecycle");
  activity.getFragmentManager().beginTransaction().detach(part).commitNow();ok(part.getView()==null&&!part.isAdded(),"fragment detach");
  activity.getFragmentManager().beginTransaction().attach(part).commitNow();ok(part.getView()!=null&&part.isResumed(),"fragment reattach");return part;
 }
 public static void destroyed(Part part){ok(part.getActivity()==null&&part.getView()==null&&Part.calls.getLast().equals("detach"),"original fragment teardown");}
}
