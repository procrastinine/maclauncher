package maclauncher.android;

/** Same terminal process boundary as Host.main, after the fixture's scoped cleanup. */
public final class HostWindowProcessProbe {
    public static void main(String[] args){
        int status=0;
        try(var workers=FirstFailure.captureWorkers()){
            try{HostWindowProbe.main(args);}
            catch(Throwable failure){FirstFailure.reportOwner(failure);status=1;}
        }
        System.exit(status);
    }
}
