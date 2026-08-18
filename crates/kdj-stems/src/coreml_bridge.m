#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

@interface KDJSCNetCoreMLHandle : NSObject
@property(nonatomic, strong) MLModel *model;
@property(nonatomic, copy) NSString *outputName;
@property(nonatomic, strong) NSURL *compiledURL;
@end

@implementation KDJSCNetCoreMLHandle
@end

static void kdj_scnet_copy_error(char *buffer, size_t capacity, NSString *message) {
    if (buffer == NULL || capacity == 0) return;
    const char *utf8 = (message ?: @"Core ML SCNet error").UTF8String;
    if (utf8 == NULL) utf8 = "Core ML SCNet error";
    snprintf(buffer, capacity, "%s", utf8);
}

void *kdj_scnet_coreml_load(const char *path, char *error, size_t error_capacity) {
    @autoreleasepool {
        if (path == NULL || path[0] == '\0') {
            kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML path is empty");
            return NULL;
        }
        if (@available(macOS 13.0, *)) {
            NSString *modelPath = [NSString stringWithUTF8String:path];
            NSURL *packageURL = [NSURL fileURLWithPath:modelPath isDirectory:YES];
            NSError *compileError = nil;
            NSURL *compiledURL = [MLModel compileModelAtURL:packageURL error:&compileError];
            if (compiledURL == nil) {
                kdj_scnet_copy_error(error, error_capacity, compileError.localizedDescription);
                return NULL;
            }

            MLModelConfiguration *configuration = [[MLModelConfiguration alloc] init];
            configuration.computeUnits = MLComputeUnitsCPUAndGPU;
            NSError *loadError = nil;
            MLModel *model = [MLModel modelWithContentsOfURL:compiledURL
                                              configuration:configuration
                                                      error:&loadError];
            if (model == nil) {
                kdj_scnet_copy_error(error, error_capacity, loadError.localizedDescription);
                return NULL;
            }
            NSString *outputName = model.modelDescription.outputDescriptionsByName.allKeys.firstObject;
            if (outputName.length == 0) {
                kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML model has no output");
                return NULL;
            }
            KDJSCNetCoreMLHandle *handle = [[KDJSCNetCoreMLHandle alloc] init];
            handle.model = model;
            handle.outputName = outputName;
            handle.compiledURL = compiledURL;
            return (__bridge_retained void *)handle;
        }
        kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML requires macOS 13 or newer");
        return NULL;
    }
}

int32_t kdj_scnet_coreml_predict(void *opaque,
                                 const float *input,
                                 size_t input_count,
                                 float *output,
                                 size_t output_count,
                                 char *error,
                                 size_t error_capacity) {
    @autoreleasepool {
        if (opaque == NULL || input == NULL || output == NULL) {
            kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML received a null buffer");
            return 1;
        }
        if (input_count != 4ull * 2049ull * 338ull ||
            output_count != 4ull * 4ull * 2049ull * 338ull) {
            kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML tensor size mismatch");
            return 2;
        }
        if (@available(macOS 13.0, *)) {
            KDJSCNetCoreMLHandle *handle = (__bridge KDJSCNetCoreMLHandle *)opaque;
            NSError *arrayError = nil;
            MLMultiArray *array = [[MLMultiArray alloc]
                initWithShape:@[@1, @4, @2049, @338]
                      dataType:MLMultiArrayDataTypeFloat16
                         error:&arrayError];
            if (array == nil) {
                kdj_scnet_copy_error(error, error_capacity, arrayError.localizedDescription);
                return 3;
            }
            _Float16 *inputHalf = (_Float16 *)array.dataPointer;
            for (size_t index = 0; index < input_count; ++index) {
                inputHalf[index] = (_Float16)input[index];
            }

            MLFeatureValue *feature = [MLFeatureValue featureValueWithMultiArray:array];
            NSError *providerError = nil;
            MLDictionaryFeatureProvider *provider = [[MLDictionaryFeatureProvider alloc]
                initWithDictionary:@{@"mix_spec": feature}
                              error:&providerError];
            if (provider == nil) {
                kdj_scnet_copy_error(error, error_capacity, providerError.localizedDescription);
                return 4;
            }
            NSError *predictionError = nil;
            id<MLFeatureProvider> prediction = [handle.model predictionFromFeatures:provider
                                                                               error:&predictionError];
            if (prediction == nil) {
                kdj_scnet_copy_error(error, error_capacity, predictionError.localizedDescription);
                return 5;
            }
            MLMultiArray *result = [prediction featureValueForName:handle.outputName].multiArrayValue;
            if (result == nil || (size_t)result.count != output_count ||
                result.dataType != MLMultiArrayDataTypeFloat16) {
                kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML output contract mismatch");
                return 6;
            }
            _Float16 *outputHalf = (_Float16 *)result.dataPointer;
            NSArray<NSNumber *> *strides = result.strides;
            if (strides.count != 5) {
                kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML output rank mismatch");
                return 7;
            }
            const size_t sourceStride = strides[1].unsignedLongLongValue;
            const size_t featureStride = strides[2].unsignedLongLongValue;
            const size_t frequencyStride = strides[3].unsignedLongLongValue;
            const size_t timeStride = strides[4].unsignedLongLongValue;
            size_t logical = 0;
            for (size_t source = 0; source < 4; ++source) {
                for (size_t featureIndex = 0; featureIndex < 4; ++featureIndex) {
                    for (size_t frequency = 0; frequency < 2049; ++frequency) {
                        const size_t base = source * sourceStride + featureIndex * featureStride +
                                            frequency * frequencyStride;
                        for (size_t time = 0; time < 338; ++time) {
                            output[logical++] = (float)outputHalf[base + time * timeStride];
                        }
                    }
                }
            }
            return 0;
        }
        kdj_scnet_copy_error(error, error_capacity, @"SCNet Core ML requires macOS 13 or newer");
        return 7;
    }
}

void kdj_scnet_coreml_free(void *opaque) {
    if (opaque == NULL) return;
    @autoreleasepool {
        (void)CFBridgingRelease(opaque);
    }
}
