#pragma once
#import <Foundation/Foundation.h>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <cstdint>

namespace macfx {
struct PresentationContract {
    std::string planRevision,controlsDigest;
    bool operator==(const PresentationContract &other)const{return planRevision==other.planRevision&&controlsDigest==other.controlsDigest;}
    bool operator!=(const PresentationContract &other)const{return !(*this==other);}
};
struct PresentationHoldCommand {
    uint64_t epoch=0;std::string transactionId,action;
    PresentationContract expected,candidate;
};
struct PresentationHoldStatus {
    std::string state="idle",transactionId,reason;
    uint64_t epoch=0,frameId=0;unsigned width=0,height=0;
    double presentedTime=0;PresentationContract contract;bool holding=false;
};
// Hash the exact stable MLFXCTL2 snapshot, at most once per reader generation.
// This is dormant unless the per-launch presentation channel is configured.
bool presentationHoldConfigured() noexcept;
std::string presentationControlsDigest();
class PresentationHoldReader {
    struct Impl;std::unique_ptr<Impl> impl;
public:
    PresentationHoldReader();~PresentationHoldReader();
    bool configured()const;
    static PresentationHoldCommand parse(NSData *,const std::string &launch,const std::string &token);
    std::optional<PresentationHoldCommand> poll();
    void status(const PresentationHoldStatus &,unsigned window);
};
class ViewPresentation;
// Main-thread only; uses the existing window-state scheduling. A target must
// already own a visible, positively presented opaque SDR output.
void pollPresentationHold(const std::function<std::shared_ptr<ViewPresentation>(std::string &)> &select);
}
