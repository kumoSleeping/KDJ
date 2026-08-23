package com.kdj.app

import org.pytorch.executorch.EValue
import org.pytorch.executorch.ExecuTorchRuntime
import org.pytorch.executorch.Module
import org.pytorch.executorch.Tensor

/**
 * JVM owner of the Android SCNet runtime.
 *
 * Rust workers invoke the two @JvmStatic methods through JNI.  Keeping Module and Vulkan state
 * here follows ExecuTorch's supported Android API, while Rust keeps the shared decode/STFT/iSTFT
 * and realtime scheduling path identical to Windows/macOS.  Calls are serialized: one Vulkan
 * program avoids duplicating SCNet's large temporary allocations on low-memory GPUs.
 */
object StemRuntime {
  private const val EXECUTORCH_VERSION = "1.0.1"
  private const val INPUT_ELEMENTS = 4 * 2049 * 338
  private const val OUTPUT_ELEMENTS = 4 * INPUT_ELEMENTS
  private val INPUT_SHAPE = longArrayOf(1, 4, 2049, 338)
  private val lock = Any()

  private var modulePath: String? = null
  private var module: Module? = null

  @JvmStatic
  fun prepare(modelPath: String): String = synchronized(lock) {
    val backends = ExecuTorchRuntime.getRegisteredBackends().toList()
    check(backends.any { it.contains("vulkan", ignoreCase = true) }) {
      "ExecuTorch Vulkan backend is not registered: ${backends.joinToString()}"
    }
    moduleFor(modelPath)
    "Vulkan · ExecuTorch $EXECUTORCH_VERSION"
  }

  @JvmStatic
  fun forward(modelPath: String, input: FloatArray): FloatArray = synchronized(lock) {
    require(input.size == INPUT_ELEMENTS) {
      "SCNet input elements ${input.size} != $INPUT_ELEMENTS"
    }
    val inputTensor = Tensor.fromBlob(input, INPUT_SHAPE)
    val outputs = moduleFor(modelPath).forward(EValue.from(inputTensor))
    require(outputs.size == 1) { "SCNet output count ${outputs.size} != 1" }
    val values = outputs[0].toTensor().getDataAsFloatArray()
    require(values.size == OUTPUT_ELEMENTS) {
      "SCNet output elements ${values.size} != $OUTPUT_ELEMENTS"
    }
    values
  }

  private fun moduleFor(path: String): Module {
    require(path.isNotBlank()) { "SCNet model path is empty" }
    val existing = module
    if (existing != null && modulePath == path) return existing
    // Model updates are rare, but replacing the module must release the old Vulkan allocations
    // before mapping the new .pte; otherwise a 2 GB device can transiently hold both programs.
    existing?.destroy()
    val loaded = Module.load(path, Module.LOAD_MODE_MMAP)
    module = loaded
    modulePath = path
    return loaded
  }
}
