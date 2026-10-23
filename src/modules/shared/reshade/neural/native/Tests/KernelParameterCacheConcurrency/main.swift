import Foundation

// This CPU-only stand-in replaces allocation/evaluation, not the cache under
// test. The runner inserts the exact upstream enum and its owned adaptation.
// No MLX module, Metal device, model or GPU submission is used.
final class MLXArray: @unchecked Sendable {
  let values: [UInt32]
  init(_ values: [UInt32]) {
    self.values = values
    Counters.lock.lock()
    Counters.created[values, default: 0] += 1
    Counters.lock.unlock()
  }
}
enum Counters {
  static let lock = NSLock()
  nonisolated(unsafe) static var created: [[UInt32]: Int] = [:]
  nonisolated(unsafe) static var published: [[UInt32]: ObjectIdentifier] = [:]
}
enum EvaluationContext {
  static let lock = NSRecursiveLock()
  static let entered = DispatchSemaphore(value: 0)
  static let finished = DispatchSemaphore(value: 0)
}
func eval(_ array: MLXArray) {
  if array.values.first == 0xFFFF { EvaluationContext.entered.signal() }
  EvaluationContext.lock.lock()
  usleep(50)
  EvaluationContext.lock.unlock()
}

// INSERT_ACTUAL_KERNEL_PARAMETER_CACHE

DispatchQueue.concurrentPerform(iterations: 16) { worker in
  for index in 0..<4096 {
    let key = UInt32((index * 17 + worker * 23) % 1024)
    let values = [key, key ^ 0xA5A5, 8, 32, key % 4]
    let first = NeuralRenderingKernelParameters.array(values)
    let second = NeuralRenderingKernelParameters.array(values)
    precondition(first.values == values && second.values == values)
    precondition(first === second, "A parameter key must retain one published buffer")
    Counters.lock.lock()
    if let published = Counters.published[values] { precondition(published == ObjectIdentifier(first)) }
    else { Counters.published[values] = ObjectIdentifier(first) }
    Counters.lock.unlock()
  }
}
precondition(Counters.created.count == 1024)
precondition(Counters.published.count == 1024)
precondition(Counters.created.values.allSatisfy { $0 >= 1 && $0 <= 16 })
print("Actual kernel parameter cache: 16 concurrent callers, 1024 unique keys, 131072 lookups, one published value per key")
fflush(stdout)

// MLX's compiled closure holds a recursive evaluation lock when calling the
// model. A concurrent plain cache miss evaluates using that same MLX lock.
// Locking this cache across eval would form cache->eval / eval->cache.
EvaluationContext.lock.lock()
DispatchQueue.global().async {
  _ = NeuralRenderingKernelParameters.array([0xFFFF])
  EvaluationContext.finished.signal()
}
precondition(EvaluationContext.entered.wait(timeout: .now() + 2) == .success)
print("Lock-order boundary: background evaluator entered; compiled closure retains evaluation lock")
fflush(stdout)
_ = NeuralRenderingKernelParameters.array([0xFFFE])
EvaluationContext.lock.unlock()
precondition(EvaluationContext.finished.wait(timeout: .now() + 2) == .success)
print("Actual cache permits MLX-style recursive compilation/evaluation lock order")
