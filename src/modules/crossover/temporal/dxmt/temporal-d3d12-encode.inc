// Copyright (c) MacLauncher contributors. MIT license.
case EncoderType::TemporalUpscale:{
 auto data=static_cast<MLTemporal12Pass*>(current);
 auto begin=cmdbuf.blitCommandEncoder();begin.waitForFence(fence_);begin.updateFence(data->scaler->fence());begin.endEncoding();
 cmdbuf.encodeTemporalScale(data->scaler->scaler(),data->images[0].texture(),data->images[3].texture(),data->images[1].texture(),data->images[2].texture(),data->images[4].texture(),data->scaler->fence(),data->props);
 auto end=cmdbuf.blitCommandEncoder();end.waitForFence(data->scaler->fence());end.updateFence(fence_);end.endEncoding();
 break;
}
