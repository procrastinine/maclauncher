#pragma once
#include <cmath>
namespace macfx {
struct VirtualWindowVisibility {
    bool applicationActive=false,applicationHidden=false;
    bool sourceOrdered=false,outputOrdered=false,sourceOnActiveSpace=false,outputOnActiveSpace=false;
    bool sourceMinimized=false,outputMinimized=false,transitioning=false;
    bool sourceVisible=false,outputVisible=false,outputOpaque=false,outputRevealed=false;
};
inline bool virtualVisibilityUsable(const VirtualWindowVisibility &v) noexcept {
    return !v.applicationHidden&&v.sourceOrdered&&v.outputOrdered&&v.sourceOnActiveSpace&&v.outputOnActiveSpace&&
        !v.sourceMinimized&&!v.outputMinimized&&!v.transitioning;
}
enum class VirtualRevealGate { Defer, Wait, Physical, Covered };
// Original occlusion is captured BEFORE the proxy can cover it. Two samples
// separated by a metadata interval reject unsettled initial AppKit flags.
class VirtualBackgroundActivation {
    double originalSince=-1,outputSince=-1;
    bool originalVerified=false;
public:
    VirtualRevealGate beforeReveal(const VirtualWindowVisibility &v,double now) noexcept {
        if(!std::isfinite(now)||!virtualVisibilityUsable(v)){originalSince=-1;originalVerified=false;return VirtualRevealGate::Defer;}
        if(v.applicationActive||v.sourceVisible){originalSince=-1;originalVerified=false;return VirtualRevealGate::Physical;}
        if(originalSince<0){originalSince=now;return VirtualRevealGate::Wait;}
        if(now-originalSince<.1)return VirtualRevealGate::Wait;
        originalVerified=true;return VirtualRevealGate::Covered;
    }
    bool canCommitCovered(const VirtualWindowVisibility &v,double now) noexcept {
        // Once any part becomes visible, or the game becomes foreground,
        // this preparation needs the real display gate even if covered again.
        if(!std::isfinite(now)||!virtualVisibilityUsable(v)||v.applicationActive||v.sourceVisible||v.outputVisible)originalVerified=false;
        if(!originalVerified||
           !v.outputOpaque||!v.outputRevealed){outputSince=-1;return false;}
        if(outputSince<0){outputSince=now;return false;}
        return now-outputSince>=.1;
    }
};
}
