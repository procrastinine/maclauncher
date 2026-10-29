// Copyright (c) MacLauncher contributors. MIT license.
// RIFE v4.6 graph from the pinned nihui/rife-ncnn-vulkan model parameters.
// Original RIFE and the native port use the MIT license; weights are separate.
import Foundation
import MLX

final class RIFEInterpolation: @unchecked Sendable {
  let weights:[String:MLXArray]
  static let channels=[192,128,96,64]
  static let shapes:[String:[Int]] = {
    var result:[String:[Int]]=[:]
    func conv(_ name:String,_ input:Int,_ output:Int,_ kernel:Int=3){result[name+".weight"]=[output,kernel,kernel,input];result[name+".bias"]=[output]}
    for (stage,c) in channels.enumerated(){
      conv("convrelu_\(stage*2)",stage==0 ? 7:12,c/2);conv("convrelu_\(stage*2+1)",c/2,c)
      for i in 0..<8{conv("conv_\(22+stage*10+i)",c,c)}
      conv("deconv_\(60+stage)",c,24,4)
    }
    return result
  }()
  init(modelURL:URL)throws{
    let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:modelURL.appendingPathComponent("manifest.json"))) as? [String:Any]
    guard manifest?["architecture"] as? String == "rife.v4.6.ncnn.v1",let row=manifest?["weights"] as? [String:Any],let file=row["file"] as? String,URL(fileURLWithPath:file).lastPathComponent==file else {throw RestorationError(message:"Choose the exact RIFE v4.6 interpolation checkpoint")}
    let values=try loadArrays(url:modelURL.appendingPathComponent(file),stream:.cpu)
    guard Set(values.keys)==Set(Self.shapes.keys),Self.shapes.allSatisfy({name,shape in values[name]?.shape==shape && [DType.float16,.float32].contains(values[name]!.dtype)}) else {throw RestorationError(message:"RIFE v4.6 tensor names, channels or layouts differ from the graph")}
    weights=values.mapValues{$0.asType(.float32)};eval(Array(weights.values))
  }
  private func conv(_ name:String,_ x:MLXArray,stride:Int=1,transpose:Bool=false)->MLXArray{
    let weight=weights[name+".weight"]!
    return (transpose ? convTransposed2d(x,weight,stride:2,padding:1) : conv2d(x,weight,stride:IntOrPair(stride),padding:1))+weights[name+".bias"]!
  }
  private func act(_ x:MLXArray)->MLXArray{maximum(x,0)+minimum(x,0)*0.2}
  private static let sampling=MLXFast.metalKernel(name:"maclauncher_rife46_sample",inputNames:["image","flow","shape"],outputNames:["output"],source:#"""
    uint i=thread_position_in_grid.x,w=shape[0],h=shape[1],ow=shape[2],oh=shape[3],channels=shape[4];
    if(i>=ow*oh*channels)return;uint c=i%channels,x=(i/channels)%ow,y=i/(ow*channels);
    float px,py;if(shape[5]){px=float(x)+flow[(y*ow+x)*2];py=float(y)+flow[(y*ow+x)*2+1];}
    else{px=(float(x)+.5f)*float(w)/float(ow)-.5f;py=(float(y)+.5f)*float(h)/float(oh)-.5f;}
    float fx=floor(px),fy=floor(py),tx=px-fx,ty=py-fy;
    uint x0=clamp(int(fx),0,int(w)-1),x1=clamp(int(fx)+1,0,int(w)-1),y0=clamp(int(fy),0,int(h)-1),y1=clamp(int(fy)+1,0,int(h)-1);
    output[i]=mix(mix(float(image[(y0*w+x0)*channels+c]),float(image[(y0*w+x1)*channels+c]),tx),mix(float(image[(y1*w+x0)*channels+c]),float(image[(y1*w+x1)*channels+c]),tx),ty);
    """#)
  private func sampled(_ x:MLXArray,width:Int,height:Int,flow:MLXArray?=nil)->MLXArray{
    if flow == nil && x.dim(1)==height && x.dim(2)==width{return x}
    let shape=MLXArray([UInt32(x.dim(2)),UInt32(x.dim(1)),UInt32(width),UInt32(height),UInt32(x.dim(3)),flow == nil ? 0:1])
    return Self.sampling([contiguous(x),contiguous(flow ?? MLXArray.zeros([1])),shape],grid:(width*height*x.dim(3),1,1),threadGroup:(256,1,1),outputShapes:[[1,height,width,x.dim(3)]],outputDTypes:[.float32])[0]
  }
  func callAsFunction(_ previous:MLXArray,_ current:MLXArray,phase:Float)->MLXArray{
    let h=previous.dim(1),w=previous.dim(2),ph=(h+31)/32*32,pw=(w+31)/32*32
    let a=padded(previous,widths:[[0,0],[0,ph-h],[0,pw-w],[0,0]]),b=padded(current,widths:[[0,0],[0,ph-h],[0,pw-w],[0,0]])
    let time=MLXArray.full([1,ph,pw,1],values:MLXArray(phase))
    var flow:MLXArray?,mask:MLXArray?,wa=a,wb=b
    for stage in 0..<4{
      let scale=1<<(3-stage),sh=ph/scale,sw=pw/scale
      var input=sampled(concatenated([wa,wb,time]+(mask.map{[$0]} ?? []),axis:3),width:sw,height:sh)
      if let flow{input=concatenated([input,sampled(flow,width:sw,height:sh)/Float(scale)],axis:3)}
      var value=act(conv("convrelu_\(stage*2)",input,stride:2))
      value=act(conv("convrelu_\(stage*2+1)",value,stride:2))
      for i in 0..<8{value=act(conv("conv_\(22+stage*10+i)",value)+value)}
      value=conv("deconv_\(60+stage)",value,transpose:true)
      let s=value.shape;value=value.reshaped([1,s[1],s[2],6,2,2]).transposed(0,1,4,2,5,3).reshaped([1,s[1]*2,s[2]*2,6])
      value=sampled(value,width:pw,height:ph)
      let delta=value[0...,0...,0...,0..<4]*Float(scale),maskDelta=value[0...,0...,0...,4..<5]
      flow=flow.map{$0+delta} ?? delta;mask=mask.map{$0+maskDelta} ?? maskDelta
      wa=sampled(a,width:pw,height:ph,flow:flow![0...,0...,0...,0..<2])
      wb=sampled(b,width:pw,height:ph,flow:flow![0...,0...,0...,2..<4])
    }
    let blend=sigmoid(mask!);return (wa*blend+wb*(1-blend))[0...,0..<h,0..<w,0...]
  }
}
