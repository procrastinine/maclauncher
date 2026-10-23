package maclauncher.android.web;

import android.os.*;
import android.view.*;
import android.view.inputmethod.BaseInputConnection;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.PackageManifest;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Original Android editing rules with an observed document-state boundary. */
public final class WebKitEditorProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString());
        Path apk=data.resolve("fixture.apk");PackageManifest.add(apk,"webkit");
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("org.example.window","1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostClassLoader(WebKitEditorProbe.class.getClassLoader());
        HostPackages.inspectSources(List.of(apk));HostDisplay.hostPublish(1,320,240,60);
        HostApplication.prepare(WebKitEditorProbe.class.getClassLoader());
        try{
            View view=new View(new ContextThemeWrapper(HostApplication.applicationContext(),android.R.style.Theme_Material));
            var updates=new ArrayList<WebKitEditor.State>();var revisions=new ArrayList<Long>();
            var target=new WebKitEditor.Target(){
                public void update(WebKitEditor.State before,WebKitEditor.State after,long revision){updates.add(after);revisions.add(revision);}
                public boolean action(WebKitEditor editor,int action){return false;}
                public boolean key(KeyEvent event){return true;}
            };
            WebKitEditor editor=new WebKitEditor(view,new Handler(loop),target,new WebKitEditor.State("A😀BC",3,3,-1,-1),0);
            check(editor.commitText("é",1),"original commit succeeds");
            check(editor.getEditable().toString().equals("A😀éBC")&&updates.size()==1,"one original commit publishes once");
            check(editor.setComposingText("日本",1),"original composing text");
            check(editor.getEditable().toString().equals("A😀é日本BC")&&BaseInputConnection.getComposingSpanStart(editor.getEditable())==4&&BaseInputConnection.getComposingSpanEnd(editor.getEditable())==6,"UTF-16 composing range belongs to original spans");
            editor.setSelection(5,5);HostLooper.drain(loop);
            editor.setComposingText("に",0);
            check(editor.getEditable().toString().equals("A😀éにBC")&&android.text.Selection.getSelectionStart(editor.getEditable())==4,"composition replacement retains original cursor semantics");
            editor.finishComposingText();
            check(BaseInputConnection.getComposingSpanStart(editor.getEditable())==-1,"original finish removes composition");
            var surrounding=editor.getSurroundingText(2,2,0);check(surrounding.getSelectionStart()==2&&surrounding.getSelectionEnd()==2&&surrounding.getOffset()==2,"original surrounding text retains UTF-16 offsets");
            check(editor.setSelection(-1,Integer.MAX_VALUE),"original invalid selection is ignored successfully");
            check(android.text.Selection.getSelectionStart(editor.getEditable())==4,"invalid selection leaves cursor unchanged");
            try{editor.getSurroundingText(-1,0,0);throw new AssertionError("negative surrounding length accepted");}catch(IllegalArgumentException expected){}
            long revision=revisions.get(revisions.size()-1);editor.synchronize(new WebKitEditor.State("stale",0,0,-1,-1),revision-1);
            check(editor.getEditable().toString().equals("A😀éにBC"),"late document callback cannot overwrite pending Android edit");
            int count=updates.size();editor.synchronize(new WebKitEditor.State("A😀B",3,3,-1,-1),revision+1);
            check(editor.deleteSurroundingTextInCodePoints(1,0)&&editor.getEditable().toString().equals("AB"),"original code-point deletion removes the complete surrogate pair");
            check(updates.size()==count+1,"document synchronization never echoes an extra edit");
            editor.beginBatchEdit();editor.commitText("x",1);editor.commitText("y",1);check(updates.size()==count+1,"nested original edits wait for outer batch");editor.endBatchEdit();check(updates.size()==count+2,"one document publication closes outer batch");
            editor.setSelection(0,0);editor.retire();HostLooper.drain(loop);check(updates.size()==count+2,"retirement cancels queued document writes");
            System.out.println("PASS original WebKit Editable: single commit, UTF-16, composition, surrounding text, code-point deletion, batching and stale callback ownership");
        }finally{HostApplication.shutdown();HostDisplayEvents.hostShutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();HostContext.hostShutdown();FrameworkResources.shutdown();HostLooper.close(loop);}
    }
}
