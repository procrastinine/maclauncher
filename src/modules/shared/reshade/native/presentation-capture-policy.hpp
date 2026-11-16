#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
namespace macfx {
// Outcome of offering one game frame to the window's owned presentation.
enum class PresentationFrameOutcome { Encoded, Declined, Failed };
// A pending final-image screenshot is read from the image the window actually
// displays. Until the owned presentation reveals its output, that image is the
// game's own drawable. A declined frame (for example while the output window
// is occluded or hidden, which declines every frame) is therefore captured from
// the game's drawable; otherwise the request would stay pending for as long as
// the window is covered. After the reveal the retained processed image is
// displayed, so the request waits for the next frame the presentation encodes.
template<class Result,class Capture>
PresentationFrameOutcome presentationFrameWithScreenshot(const Result&result,bool revealed,Capture capture){
 if(result.encoded)return PresentationFrameOutcome::Encoded;
 if(!result.busy)return PresentationFrameOutcome::Failed;
 if(!revealed)capture();
 return PresentationFrameOutcome::Declined;
}
}
