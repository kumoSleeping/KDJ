/* ort's macOS static library references newer Core ML classes even when KDJ
 * only creates a CPU session. Those symbols are hidden at MACOSX_DEPLOYMENT_TARGET
 * 11.0, so provide weak placeholders that propagate into every dependent crate. */
void *OBJC_CLASS_$_MLComputePlan __attribute__((weak)) = 0;
void *OBJC_CLASS_$_MLOptimizationHints __attribute__((weak)) = 0;
