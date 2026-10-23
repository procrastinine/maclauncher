#include "virtual-visibility.hpp"
#include <cassert>
#include <cstdio>
using namespace macfx;
static VirtualWindowVisibility window(){VirtualWindowVisibility v;
    v.sourceOrdered=v.outputOrdered=v.sourceOnActiveSpace=v.outputOnActiveSpace=true;return v;}
int main(){
    // An alpha-zero prepared output is not evidence that the ORIGINAL was
    // externally covered. The visible original always retains the real gate.
    auto visible=window();visible.sourceVisible=true;
    VirtualBackgroundActivation foreground;
    assert(foreground.beforeReveal(visible,1)==VirtualRevealGate::Physical);
    visible.sourceVisible=false;visible.outputOpaque=visible.outputRevealed=true;
    assert(!foreground.canCommitCovered(visible,1.2));
    assert(!foreground.canCommitCovered(visible,1.4)); // Own proxy occlusion alone.
    // Settled original coverage is required before opaque reveal, followed by
    // settled source+output coverage. GPU-ready is checked by the real caller.
    auto covered=window();VirtualBackgroundActivation background;
    assert(background.beforeReveal(covered,2)==VirtualRevealGate::Wait);
    assert(background.beforeReveal(covered,2.2)==VirtualRevealGate::Covered);
    assert(!background.canCommitCovered(covered,2.4)); // Prepared alpha0/transparent host.
    covered.outputRevealed=covered.outputOpaque=true;
    assert(!background.canCommitCovered(covered,2.5));
    assert(background.canCommitCovered(covered,2.7));
    covered.outputVisible=true;assert(!background.canCommitCovered(covered,2.8));
    covered.outputVisible=false;assert(!background.canCommitCovered(covered,2.9));
    assert(!background.canCommitCovered(covered,3.1)); // Visibility retains the real gate after reocclusion.
    VirtualBackgroundActivation verified;assert(verified.beforeReveal(covered,3.2)==VirtualRevealGate::Wait);
    assert(verified.beforeReveal(covered,3.4)==VirtualRevealGate::Covered);
    auto active=covered;active.applicationActive=true;auto becameActive=verified;
    assert(!becameActive.canCommitCovered(active,3.6));assert(!becameActive.canCommitCovered(covered,3.8));
    for(unsigned fault=0;fault<7;++fault){auto invalid=covered;
        switch(fault){case 0:invalid.applicationHidden=true;break;case 1:invalid.sourceOnActiveSpace=false;break;
            case 2:invalid.outputOnActiveSpace=false;break;case 3:invalid.sourceMinimized=true;break;
            case 4:invalid.outputMinimized=true;break;case 5:invalid.transitioning=true;break;case 6:invalid.sourceOrdered=false;break;}
        VirtualBackgroundActivation deferred;assert(deferred.beforeReveal(invalid,4)==VirtualRevealGate::Defer);
        auto interruptedState=verified;assert(!interruptedState.canCommitCovered(invalid,4.2));
        assert(!interruptedState.canCommitCovered(covered,4.4));
    }
    // An interrupted before-reveal observation cannot later be relabelled as
    // pre-existing coverage after our own output has hidden a visible source.
    VirtualBackgroundActivation interrupted;auto start=window();
    assert(interrupted.beforeReveal(start,5)==VirtualRevealGate::Wait);
    start.sourceVisible=true;assert(interrupted.beforeReveal(start,5.2)==VirtualRevealGate::Physical);
    start.sourceVisible=false;start.outputOpaque=start.outputRevealed=true;
    assert(!interrupted.canCommitCovered(start,5.4));
    std::puts("virtual visibility: pre-existing coverage, transparent/own-occlusion rejection, foreground/visible real gate retained after reocclusion and transition/Space/minimize deferral");
}
