package android.view.inputmethod;
import android.text.*;
public final class TextInputProbe {
 static int checks;static void check(boolean v){checks++;if(!v)throw new AssertionError("input check "+checks);}
 public static void run(android.content.Context context){
  var view=new android.view.View(context);BaseInputConnection input=new BaseInputConnection(view,true);Editable text=input.getEditable();
  check(input.commitText("a😀z",1));check(text.toString().equals("a😀z")&&Selection.getSelectionStart(text)==4);
  input.setSelection(3,3);check(input.deleteSurroundingTextInCodePoints(1,0));check(text.toString().equals("az")&&Selection.getSelectionStart(text)==1);
  input.setComposingText("XY",1);check(text.toString().equals("aXYz"));check(BaseInputConnection.getComposingSpanStart(text)==1&&BaseInputConnection.getComposingSpanEnd(text)==3);
  input.setComposingText("Q",1);check(text.toString().equals("aQz"));input.commitText("done",1);check(text.toString().equals("adonez")&&BaseInputConnection.getComposingSpanStart(text)==-1);
  input.setSelection(1,5);check(input.getSelectedText(0).toString().equals("done"));check(input.getTextBeforeCursor(20,0).toString().equals("a"));check(input.getTextAfterCursor(20,0).toString().equals("z"));
  input.setComposingRegion(0,2);input.finishComposingText();check(BaseInputConnection.getComposingSpanStart(text)==-1);
  input.setSelection(1,1);input.commitText("X",0);check(Selection.getSelectionStart(text)==1);
  text.replace(0,text.length(),"\ud800x");Selection.setSelection(text,1);input.deleteSurroundingTextInCodePoints(1,0);check(text.toString().equals("\ud800x"));
  input.closeConnection();check(!input.requestCursorUpdates(1));
  class Fallback extends BaseInputConnection{android.view.KeyEvent last;Fallback(){super(view,false);}public boolean sendKeyEvent(android.view.KeyEvent e){last=e;return true;}}
  Fallback fallback=new Fallback();fallback.commitText("é🎮",1);check(fallback.last.getAction()==android.view.KeyEvent.ACTION_MULTIPLE&&fallback.last.getCharacters().equals("é🎮")&&fallback.getEditable().length()==0&&fallback.last.getDeviceId()==-1&&fallback.last.getFlags()==0);
  System.out.println("PASS "+checks+" upstream input composition, cursor and Unicode deletion checks");
 }
}
