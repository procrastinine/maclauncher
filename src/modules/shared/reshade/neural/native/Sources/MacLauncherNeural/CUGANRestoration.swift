// Copyright (c) MacLauncher contributors. MIT license.
// UpCunet2x/3x/4x architectures: Bilibili AI Lab, MIT license. Complete
// frame graph: SE means cover the actual full feature image, never isolated tiles.
import Foundation
import MLX

final class CUGANRestoration: @unchecked Sendable {
  let weights:[String:MLXArray]
  let scale:Int
  static let shapes=shapes(scale:2)
  static func shapes(scale:Int)->[String:[Int]] {
    var result:[String:[Int]]=[:]
    func conv(_ name:String,_ input:Int,_ output:Int,_ kernel:Int){result[name+".weight"]=[output,kernel,kernel,input];result[name+".bias"]=[output]}
    func block(_ name:String,_ input:Int,_ middle:Int,_ output:Int,_ se:Bool){
      conv(name+".conv.0",input,middle,3);conv(name+".conv.2",middle,output,3)
      if se{conv(name+".seblock.conv1",output,output/8,1);conv(name+".seblock.conv2",output/8,output,1)}
    }
    block("unet1.conv1",3,32,64,false);conv("unet1.conv1_down",64,64,2)
    block("unet1.conv2",64,128,64,true);conv("unet1.conv2_up",64,64,2)
    let channels=scale==4 ? 64:3
    conv("unet1.conv3",64,64,3);conv("unet1.conv_bottom",64,channels,scale==3 ? 5:4)
    block("unet2.conv1",channels,32,64,false);conv("unet2.conv1_down",64,64,2)
    block("unet2.conv2",64,64,128,true);conv("unet2.conv2_down",128,128,2)
    block("unet2.conv3",128,256,128,true);conv("unet2.conv3_up",128,128,2)
    block("unet2.conv4",128,64,64,true);conv("unet2.conv4_up",64,64,2)
    conv("unet2.conv5",64,64,3);conv("unet2.conv_bottom",64,channels,3)
    if scale==4{conv("conv_final",64,12,3)}
    return result
  }
  static func modelScale(modelURL:URL)throws->Int{
    let file=modelURL.appendingPathComponent("manifest.json")
    guard let bytes=try file.resourceValues(forKeys:[.fileSizeKey]).fileSize,bytes>0,bytes<=1_048_576,
      let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as? [String:Any],
      let architecture=manifest["architecture"] as? String,
      let scale=["realcugan.upcunet2x.v1":2,"realcugan.upcunet3x.v1":3,"realcugan.upcunet4x.v1":4][architecture] else {throw RestorationError(message:"Choose the complete Real-CUGAN UpCunet2x, 3x or 4x checkpoint")}
    return scale
  }
  init(modelURL:URL)throws{
    let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:modelURL.appendingPathComponent("manifest.json"))) as? [String:Any]
    let selectedScale=try Self.modelScale(modelURL:modelURL),expected=Self.shapes(scale:selectedScale)
    guard let record=manifest?["weights"] as? [String:Any],let file=record["file"] as? String,URL(fileURLWithPath:file).lastPathComponent==file else {throw RestorationError(message:"Choose the complete Real-CUGAN checkpoint")}
    let values=try loadArrays(url:modelURL.appendingPathComponent(file),stream:.cpu)
    guard Set(values.keys)==Set(expected.keys),expected.allSatisfy({name,shape in values[name]?.shape==shape && [DType.float16,.float32].contains(values[name]!.dtype)}) else {throw RestorationError(message:"Real-CUGAN requires exact NHWC convolution and transposed-convolution tensors")}
    scale=selectedScale
    weights=values.mapValues{$0.asType(.float32)};eval(Array(weights.values))
  }
  private func conv(_ name:String,_ x:MLXArray,stride:Int=1,transpose:Bool=false,padding:Int=0)->MLXArray{
    let w=weights[name+".weight"]!,b=weights[name+".bias"]!
    return (transpose ? convTransposed2d(x,w,stride:IntOrPair(stride),padding:IntOrPair(padding)) : conv2d(x,w,stride:IntOrPair(stride)))+b
  }
  private func activation(_ x:MLXArray)->MLXArray{maximum(x,0)+minimum(x,0)*0.1}
  private func crop(_ x:MLXArray,_ border:Int)->MLXArray{x[0...,border..<(x.dim(1)-border),border..<(x.dim(2)-border),0...]}
  private func block(_ name:String,_ x:MLXArray,se:Bool)->MLXArray{
    let value=activation(conv(name+".conv.2",activation(conv(name+".conv.0",x))))
    if !se{return value}
    let mean=value.asType(.float32).mean(axes:[1,2],keepDims:true)
    let attention=sigmoid(conv(name+".seblock.conv2",maximum(conv(name+".seblock.conv1",mean),0)))
    return value*attention
  }
  private func unet1(_ x:MLXArray)->MLXArray{
    let first=block("unet1.conv1",x,se:false)
    var low=activation(conv("unet1.conv1_down",first,stride:2))
    low=block("unet1.conv2",low,se:true)
    low=activation(conv("unet1.conv2_up",low,stride:2,transpose:true))
    return conv("unet1.conv_bottom",activation(conv("unet1.conv3",crop(first,4)+low)),stride:scale==3 ? 3:2,transpose:true,padding:scale==3 ? 2:3)
  }
  private func unet2(_ x:MLXArray)->MLXArray{
    let first=block("unet2.conv1",x,se:false)
    let second=block("unet2.conv2",activation(conv("unet2.conv1_down",first,stride:2)),se:true)
    var third=block("unet2.conv3",activation(conv("unet2.conv2_down",second,stride:2)),se:true)
    third=activation(conv("unet2.conv3_up",third,stride:2,transpose:true))
    var fourth=block("unet2.conv4",crop(second,4)+third,se:true)
    fourth=activation(conv("unet2.conv4_up",fourth,stride:2,transpose:true))
    return conv("unet2.conv_bottom",activation(conv("unet2.conv5",crop(first,16)+fourth)))
  }
  func callAsFunction(_ input:MLXArray)->MLXArray{
    let h=input.dim(1),w=input.dim(2),divisor=scale==3 ? 4:2,border=scale==3 ? 14:scale==4 ? 19:18
    let ph=(h+divisor-1)/divisor*divisor,pw=(w+divisor-1)/divisor*divisor
    func reflected(_ size:Int,_ extent:Int)->MLXArray{
      let period=max(1,2*(size-1))
      // Coordinate metadata only; image values stay on the GPU.
      return MLXArray((-border..<(extent+border)).map{position->Int32 in let n=((position%period)+period)%period;return Int32(size==1 ? 0 : n<size ? n:period-n)})
    }
    let extended=input.take(reflected(h,ph),axis:1).take(reflected(w,pw),axis:2)
    let first=unet1(extended)
    var output=unet2(first)+crop(first,20)
    if scale==4{
      output=crop(conv("conv_final",output),1)
      let s=output.shape
      output=output.reshaped([s[0],s[1],s[2],3,2,2]).transposed(0,1,4,2,5,3).reshaped([s[0],s[1]*2,s[2]*2,3])
      return output[0...,0..<(h*4),0..<(w*4),0...]+MLXArray.repeated(MLXArray.repeated(input,count:4,axis:1),count:4,axis:2)
    }
    return output[0...,0..<(h*scale),0..<(w*scale),0...]
  }
}
