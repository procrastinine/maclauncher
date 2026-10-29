// Copyright (c) MacLauncher contributors. MIT license.
// NAFNet: Copyright Megvii Research. MIT license; pinned MLX/TLC adaptation
// identities and original notices accompany restoration-sources.json.
import Foundation
import MLX

final class NAFRestoration: @unchecked Sendable {
  struct Profile {
    let encoders: [Int], decoders: [Int], middle: Int
    let local: Bool
    static let sidd = Profile(encoders: [2,2,4,8], decoders: [2,2,2,2], middle: 12, local: false)
    static let gopro = Profile(encoders: [1,1,1,28], decoders: [1,1,1,1], middle: 1, local: true)
  }
  let profile: Profile
  let weights: [String: MLXArray]
  static func shapes(_ profile: Profile) -> [String: [Int]] {
    var result: [String: [Int]] = [:]
    func conv(_ name: String, _ input: Int, _ output: Int, _ kernel: Int = 1, _ bias: Bool = true, _ groups: Int = 1) {
      result[name+".weight"] = [output,kernel,kernel,input/groups]
      if bias { result[name+".bias"] = [output] }
    }
    func block(_ prefix: String, _ channels: Int) {
      conv(prefix+".conv1",channels,channels*2)
      conv(prefix+".conv2",channels*2,channels*2,3,true,channels*2)
      conv(prefix+".conv3",channels,channels)
      conv(prefix+".sca",channels,channels)
      conv(prefix+".conv4",channels,channels*2)
      conv(prefix+".conv5",channels,channels)
      for name in ["norm1","norm2"] { result[prefix+"."+name+".weight"]=[channels];result[prefix+"."+name+".bias"]=[channels] }
      for name in ["beta","gamma"] { result[prefix+"."+name]=[1,1,1,channels] }
    }
    conv("intro",3,64,3);conv("ending",64,3,3)
    var channels=64
    for (stage,count) in profile.encoders.enumerated() {
      for i in 0..<count { block("encoders.\(stage).\(i)",channels) }
      conv("downs.\(stage)",channels,channels*2,2);channels*=2
    }
    for i in 0..<profile.middle { block("middle_blks.\(i)",channels) }
    for (stage,count) in profile.decoders.enumerated() {
      conv("ups.\(stage)",channels,channels*2,1,false);channels/=2
      for i in 0..<count { block("decoders.\(stage).\(i)",channels) }
    }
    return result
  }
  convenience init(modelURL: URL) throws {
    let manifest=try JSONSerialization.jsonObject(with: Data(contentsOf:modelURL.appendingPathComponent("manifest.json"))) as? [String:Any]
    guard let architecture=manifest?["architecture"] as? String,
      ["nafnet.sidd-width64.v1","nafnet.gopro-width64.tlc.v1"].contains(architecture),
      let descriptor=manifest?["weights"] as? [String:Any],let file=descriptor["file"] as? String,
      URL(fileURLWithPath:file).lastPathComponent==file else {throw RestorationError(message:"Choose the exact SIDD or GoPro NAFNet checkpoint")}
    try self.init(profile:architecture.contains("gopro") ? .gopro : .sidd,weights:loadArrays(url:modelURL.appendingPathComponent(file),stream:.cpu))
  }
  init(profile: Profile, weights: [String:MLXArray]) throws {
    let expected=Self.shapes(profile)
    guard Set(expected.keys)==Set(weights.keys),expected.allSatisfy({name,shape in weights[name]?.shape==shape && weights[name]!.dtype == .float32}) else {
      throw RestorationError(message:"NAFNet requires its exact NHWC float32 checkpoint and block configuration")
    }
    self.profile=profile;self.weights=weights;eval(Array(weights.values))
  }
  private func conv(_ name:String,_ x:MLXArray,stride:Int=1,padding:Int=0,groups:Int=1)->MLXArray {
    let output=conv2d(x,weights[name+".weight"]!,stride:IntOrPair(stride),padding:IntOrPair(padding),groups:groups)
    return weights[name+".bias"].map {output+$0} ?? output
  }
  private func norm(_ name:String,_ input:MLXArray)->MLXArray {
    let x=input.asType(.float32),mean=x.mean(axis:-1,keepDims:true),centered=x-mean
    return centered * rsqrt((centered*centered).mean(axis:-1,keepDims:true)+1e-6) * weights[name+".weight"]! + weights[name+".bias"]!
  }
  private func gate(_ x:MLXArray)->MLXArray {let parts=x.split(parts:2,axis:-1);return parts[0]*parts[1]}
  static func pool(_ input:MLXArray,kernel:Int?)->MLXArray {
    // TLC uses the fixed training-resolution kernel, never the current frame's
    // own size. Accumulation stays float32, including the summed-area table.
    let x=input.asType(.float32),h=x.dim(1),w=x.dim(2)
    guard let kernel else {return x.mean(axes:[1,2],keepDims:true)}
    let kh=min(h,kernel),kw=min(w,kernel)
    if kh>=h && kw>=w {return x.mean(axes:[1,2],keepDims:true)}
    let sum=padded(x.cumsum(axis:1).cumsum(axis:2),widths:[[0,0],[1,0],[1,0],[0,0]])
    let value=(sum[0...,kh...,kw...,0...] + sum[0...,0..<(h+1-kh),0..<(w+1-kw),0...] - sum[0...,0..<(h+1-kh),kw...,0...] - sum[0...,kh...,0..<(w+1-kw),0...]) / Float(kh*kw)
    let dh=kh-1,dw=kw-1
    return padded(value,widths:[[0,0],[dh/2,(dh+1)/2],[dw/2,(dw+1)/2],[0,0]],mode:.edge)
  }
  private func block(_ name:String,_ input:MLXArray,kernel:Int?)->MLXArray {
    var x=conv(name+".conv1",norm(name+".norm1",input))
    x=gate(conv(name+".conv2",x,padding:1,groups:x.dim(3)))
    x=conv(name+".conv3",x*conv(name+".sca",Self.pool(x,kernel:kernel)))
    let y=input+x*weights[name+".beta"]!
    x=conv(name+".conv5",gate(conv(name+".conv4",norm(name+".norm2",y))))
    return y+x*weights[name+".gamma"]!
  }
  func callAsFunction(_ input:MLXArray)->MLXArray {
    let h=input.dim(1),w=input.dim(2),padH=(16-h%16)%16,padW=(16-w%16)%16
    let original=padded(input,widths:[[0,0],[0,padH],[0,padW],[0,0]])
    var x=conv("intro",original,padding:1),skips:[MLXArray]=[]
    var kernel=384
    for (stage,count) in profile.encoders.enumerated(){
      for i in 0..<count{x=block("encoders.\(stage).\(i)",x,kernel:profile.local ? kernel:nil)}
      skips.append(x);x=conv("downs.\(stage)",x,stride:2);kernel/=2
    }
    for i in 0..<profile.middle{x=block("middle_blks.\(i)",x,kernel:profile.local ? kernel:nil)}
    for (stage,count) in profile.decoders.enumerated(){
      x=conv("ups.\(stage)",x);let s=x.shape
      x=x.reshaped([s[0],s[1],s[2],s[3]/4,2,2]).transposed(0,1,4,2,5,3).reshaped([s[0],s[1]*2,s[2]*2,s[3]/4])
      x=x+skips[skips.count-1-stage];kernel*=2
      for i in 0..<count{x=block("decoders.\(stage).\(i)",x,kernel:profile.local ? kernel:nil)}
    }
    return (conv("ending",x,padding:1)+original)[0...,0..<h,0..<w,0...]
  }
}
