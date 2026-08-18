// Isolated dual-Deck RT3S benchmark using one GPU Audio launcher and one graph.
//
// This bypasses RT3SLib's one-launcher/one-graph/one-processor wrapper. It creates two independent
// RT3S processors with separate graph inputs and output callbacks, then executes both branches in
// one GraphLauncher::Execute call. State is still physically independent per Deck.

#include <engine_api/DeviceInfoProvider.h>
#include <engine_api/GraphLauncher.h>
#include <engine_api/LauncherSpecification.h>
#include <engine_api/Module.h>
#include <engine_api/ModuleInfo.h>
#include <engine_api/ProcessData.h>
#include <engine_api/ProcessingGraph.h>
#include <engine_api/Processor.h>
#include <engine_api/RawDataPort.h>
#include <gpu_audio_client/GpuAudioManager.h>
#include <rt3s_processor/Rt3sSpecification.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <mach/mach.h>
#include <sys/resource.h>

namespace {

using Clock = std::chrono::steady_clock;
using ErrorCode = GPUA::engine::v2::ErrorCode;

constexpr uint32_t kDecks = 2;
constexpr uint32_t kInputChannels = 2;
constexpr uint32_t kOutputChannels = 8;
constexpr uint32_t kHop = 512;
constexpr double kSampleRate = 44'100.0;
constexpr double kDeadlineMs = 1'000.0 * kHop / kSampleRate;

[[noreturn]] void fail(const std::string& message) {
    throw std::runtime_error(message);
}

void check(ErrorCode code, const std::string& operation) {
    if (code != ErrorCode::eSuccess) {
        fail(operation + " failed with GPU Audio error " + std::to_string(static_cast<int>(code)));
    }
}

double elapsedMs(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

double cpuSeconds() {
    rusage usage {};
    getrusage(RUSAGE_SELF, &usage);
    return usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6 +
        usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
}

uint64_t rssBytes() {
    mach_task_basic_info info {};
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
            reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS) {
        return 0;
    }
    return info.resident_size;
}

std::vector<char> readFile(const std::string& path) {
    std::ifstream stream(path, std::ios::binary | std::ios::ate);
    if (!stream) fail("cannot open " + path);
    const auto size = stream.tellg();
    if (size <= 0) fail("empty weights file " + path);
    std::vector<char> bytes(static_cast<size_t>(size));
    stream.seekg(0);
    stream.read(bytes.data(), size);
    if (!stream) fail("cannot read " + path);
    return bytes;
}

double percentile(std::vector<double> samples, double fraction) {
    if (samples.empty()) return 0.0;
    std::sort(samples.begin(), samples.end());
    const double position = fraction * static_cast<double>(samples.size() - 1);
    const auto low = static_cast<size_t>(std::floor(position));
    const auto high = static_cast<size_t>(std::ceil(position));
    return samples[low] + (samples[high] - samples[low]) * (position - low);
}

struct Distribution {
    double mean {};
    double p50 {};
    double p95 {};
    double p99 {};
    double maximum {};
};

Distribution distribution(const std::vector<double>& values) {
    Distribution result;
    result.mean = std::accumulate(values.begin(), values.end(), 0.0) /
        static_cast<double>(values.size());
    result.p50 = percentile(values, 0.50);
    result.p95 = percentile(values, 0.95);
    result.p99 = percentile(values, 0.99);
    result.maximum = *std::max_element(values.begin(), values.end());
    return result;
}

struct RingSimulation {
    uint64_t starved_hops {};
    uint64_t underrun_transitions {};
};

RingSimulation simulateRing(const std::vector<double>& completion_ms, double initial_ms) {
    RingSimulation result;
    bool previously_starved = false;
    for (size_t hop = 0; hop < completion_ms.size(); ++hop) {
        const double consume_at = initial_ms + static_cast<double>(hop) * kDeadlineMs;
        const bool starved = completion_ms[hop] > consume_at;
        result.starved_hops += static_cast<uint64_t>(starved);
        result.underrun_transitions += static_cast<uint64_t>(starved && !previously_starved);
        previously_starved = starved;
    }
    return result;
}

using InputPointers = std::array<const float*, kInputChannels>;
using OutputPointers = std::array<float*, kOutputChannels>;

class DualGraphRt3s {
public:
    explicit DualGraphRt3s(const std::string& params_path) : weights_(readFile(params_path)) {
        gpu_audio_ = GpuAudioManager::GetGpuAudio();
        if (gpu_audio_ == nullptr) fail("GPU Audio engine is null");

        const auto& provider = gpu_audio_->GetDeviceInfoProvider();
        const auto device = GpuAudioManager::GetDeviceIndex();
        GPUA::engine::v2::LauncherSpecification launcher_spec {};
        check(provider.GetDeviceInfo(device, launcher_spec.device_info), "GetDeviceInfo");
        if (launcher_spec.device_info == nullptr) fail("GPU Audio device info is null");
        check(gpu_audio_->CreateLauncher(launcher_spec, launcher_), "CreateLauncher");
        if (launcher_ == nullptr) fail("launcher is null");
        check(launcher_->CreateProcessingGraph(graph_), "CreateProcessingGraph");
        if (graph_ == nullptr) fail("graph is null");

        auto& modules = launcher_->GetModuleProvider();
        GPUA::engine::v2::ModuleInfo selected {};
        bool found = false;
        for (uint32_t index = 0; index < modules.GetModulesCount(); ++index) {
            GPUA::engine::v2::ModuleInfo candidate {};
            if (modules.GetModuleInfo(index, candidate) == ErrorCode::eSuccess && candidate.id != nullptr &&
                std::wcscmp(candidate.id, L"rt3s") == 0) {
                selected = candidate;
                found = true;
                break;
            }
        }
        if (!found) fail("rt3s module not found");
        check(modules.GetModule(selected, module_), "GetModule(rt3s)");
        if (module_ == nullptr) fail("rt3s module is null");
    }

    DualGraphRt3s(const DualGraphRt3s&) = delete;
    DualGraphRt3s& operator=(const DualGraphRt3s&) = delete;

    ~DualGraphRt3s() {
        for (uint32_t deck = 0; deck < kDecks; ++deck) {
            if (processors_[deck] != nullptr && callback_handles_[deck] != kInvalidHandle) {
                processors_[deck]->GetOutputByPortId(0)->UnregisterPortDataCallback(
                    callback_handles_[deck]);
            }
        }
        for (auto*& processor : processors_) {
            if (processor != nullptr && module_ != nullptr) {
                module_->DeleteProcessor(processor);
                processor = nullptr;
            }
        }
        for (auto*& input : input_ports_) {
            if (input != nullptr && graph_ != nullptr) {
                graph_->DeleteInputDataPort(input);
                input = nullptr;
            }
        }
        if (graph_ != nullptr && launcher_ != nullptr) {
            launcher_->DeleteProcessingGraph(graph_);
            graph_ = nullptr;
        }
        if (launcher_ != nullptr && gpu_audio_ != nullptr) {
            gpu_audio_->DeleteLauncher(launcher_);
            launcher_ = nullptr;
        }
    }

    void arm() {
        GPUA::engine::v2::PortSpecification input_spec {
            .capacity_in_bytes = kHop * static_cast<uint32_t>(sizeof(float)),
            .data_type = GPUA::engine::v2::PortDataType::eSample32,
            .channel_count = kInputChannels,
        };

        for (uint32_t deck = 0; deck < kDecks; ++deck) {
            Rt3sConfig::Specification processor_spec {
                .params_bytes = weights_.size(),
                .params = weights_.data(),
            };
            check(module_->CreateProcessor(graph_, &processor_spec, sizeof(processor_spec),
                      processors_[deck]),
                "CreateProcessor(deck " + std::to_string(deck) + ")");
            if (processors_[deck] == nullptr) fail("processor is null");

            check(graph_->CreateInputDataPort(input_spec, input_ports_[deck],
                      GPUA::engine::v2::RawDataPortFlags::eDataStaysValid),
                "CreateInputDataPort(deck " + std::to_string(deck) + ")");
            check(processors_[deck]->SetInputByPortId(0, input_ports_[deck]),
                "SetInputByPortId(deck " + std::to_string(deck) + ")");

            routes_[deck] = {.deck = deck};
            auto* output = processors_[deck]->GetOutputByPortId(0);
            if (output == nullptr) fail("processor output is null");
            GPUA::engine::v2::PortSpecification output_spec {};
            check(output->GetSpecification(output_spec),
                "GetSpecification(output deck " + std::to_string(deck) + ")");
            if (output_spec.channel_count != kOutputChannels ||
                output_spec.capacity_in_bytes < kHop * sizeof(float)) {
                fail("unexpected RT3S output port specification");
            }
            routes_[deck].capacity_in_bytes = output_spec.capacity_in_bytes;
            check(output->RegisterPortDataCallback(&outputCallback, &routes_[deck],
                      callback_handles_[deck]),
                "RegisterPortDataCallback(deck " + std::to_string(deck) + ")");
        }
        check(graph_->Finalize(), "Finalize dual graph");
    }

    void process(const std::array<InputPointers, kDecks>& input,
        const std::array<OutputPointers, kDecks>& output) {
        for (uint32_t deck = 0; deck < kDecks; ++deck) {
            check(input_ports_[deck]->SetPortData(
                      const_cast<const float**>(input[deck].data()), kHop * sizeof(float),
                      GPUA::engine::v2::DataPortChannelLayout::eIndividual),
                "SetPortData(deck " + std::to_string(deck) + ")");
        }
        CallbackContext context {.outputs = &output};
        GPUA::engine::v2::ProcessData process_data {
            .app_data = nullptr,
            .app_data_size = 0,
            .port_callback_additional_user_data = &context,
        };
        check(launcher_->Execute(*graph_, process_data), "Execute dual graph");
        if (!context.seen[0] || !context.seen[1]) {
            fail("dual graph output callbacks: deck0=" + std::to_string(context.seen[0]) +
                " deck1=" + std::to_string(context.seen[1]) + " calls=" +
                std::to_string(context.calls) + " bytes=" +
                std::to_string(context.bytes[0]) + "," + std::to_string(context.bytes[1]) +
                " channels=" + std::to_string(context.channels[0]) + "," +
                std::to_string(context.channels[1]) + " output_ptr=" +
                std::to_string(context.output_nonnull[0]) + "," +
                std::to_string(context.output_nonnull[1]) + " port_ptr=" +
                std::to_string(context.port_nonnull[0]) + "," +
                std::to_string(context.port_nonnull[1]) + " spec_code=" +
                std::to_string(context.spec_code[0]) + "," +
                std::to_string(context.spec_code[1]));
        }
    }

private:
    static constexpr uint32_t kInvalidHandle = std::numeric_limits<uint32_t>::max();

    struct Route {
        uint32_t deck {};
        uint32_t capacity_in_bytes {};
    };

    struct CallbackContext {
        const std::array<OutputPointers, kDecks>* outputs {};
        std::array<bool, kDecks> seen {};
        std::array<uint32_t, kDecks> bytes {};
        std::array<uint32_t, kDecks> channels {};
        std::array<bool, kDecks> output_nonnull {};
        std::array<bool, kDecks> port_nonnull {};
        std::array<int, kDecks> spec_code {};
        uint32_t calls {};
    };

    static void outputCallback(void* user_data, void* execution_data,
        const GPUA::engine::v2::DataPort* port, const void* output_data, uint32_t data_size) {
        const auto* route = static_cast<const Route*>(user_data);
        auto* context = static_cast<CallbackContext*>(execution_data);
        if (context != nullptr) ++context->calls;
        if (route == nullptr || context == nullptr || route->deck >= kDecks) {
            return;
        }
        context->bytes[route->deck] = data_size;
        context->output_nonnull[route->deck] = output_data != nullptr;
        context->port_nonnull[route->deck] = port != nullptr;
        if (context->outputs == nullptr || port == nullptr || output_data == nullptr) return;
        context->channels[route->deck] = kOutputChannels;
        // The proprietary macOS engine reports zero data_size for synchronous callbacks. The SDK's
        // own SyncOutputCallback deliberately ignores it and copies the caller-requested fixed
        // frame size. RT3S has a fixed 512-sample output contract, so mirror that behaviour.
        const uint32_t samples = kHop;
        for (uint32_t channel = 0; channel < kOutputChannels; ++channel) {
            const auto* source = reinterpret_cast<const char*>(output_data) +
                channel * route->capacity_in_bytes;
            std::memcpy((*context->outputs)[route->deck][channel], source,
                samples * sizeof(float));
        }
        context->seen[route->deck] = samples == kHop;
    }

    std::vector<char> weights_;
    GPUA::engine::v2::GpuAudio* gpu_audio_ {};
    GPUA::engine::v2::GraphLauncher* launcher_ {};
    GPUA::engine::v2::ProcessingGraph* graph_ {};
    GPUA::engine::v2::Module* module_ {};
    std::array<GPUA::engine::v2::Processor*, kDecks> processors_ {};
    std::array<GPUA::engine::v2::RawDataPort*, kDecks> input_ports_ {};
    std::array<Route, kDecks> routes_ {};
    std::array<uint32_t, kDecks> callback_handles_ {kInvalidHandle, kInvalidHandle};
};

void fillInput(std::array<std::array<std::array<float, kHop>, kInputChannels>, kDecks>& input,
    uint64_t hop) {
    for (uint32_t deck = 0; deck < kDecks; ++deck) {
        for (uint32_t channel = 0; channel < kInputChannels; ++channel) {
            for (uint32_t sample = 0; sample < kHop; ++sample) {
                const double frame = static_cast<double>(hop * kHop + sample);
                const double time = frame / kSampleRate;
                const double fundamental = 55.0 + 17.0 * deck + 9.0 * channel;
                input[deck][channel][sample] = static_cast<float>(
                    0.28 * std::sin(2.0 * M_PI * fundamental * time) +
                    0.17 * std::sin(2.0 * M_PI * (fundamental * 4.0) * time) +
                    0.07 * std::sin(2.0 * M_PI * (fundamental * 13.0) * time));
            }
        }
    }
}

void printDistribution(const Distribution& value) {
    std::cout << "{\"mean\":" << value.mean << ",\"p50\":" << value.p50
              << ",\"p95\":" << value.p95 << ",\"p99\":" << value.p99
              << ",\"max\":" << value.maximum << '}';
}

int run(const std::string& params_path, uint64_t hops) {
    const uint64_t rss_before = rssBytes();
    const auto create_start = Clock::now();
    DualGraphRt3s separator(params_path);
    const double create_ms = elapsedMs(create_start);
    const auto arm_start = Clock::now();
    separator.arm();
    const double arm_ms = elapsedMs(arm_start);
    const uint64_t rss_armed = rssBytes();

    std::array<std::array<std::array<float, kHop>, kInputChannels>, kDecks> input {};
    std::array<std::array<std::array<float, kHop>, kOutputChannels>, kDecks> output {};
    std::array<InputPointers, kDecks> input_ptrs {};
    std::array<OutputPointers, kDecks> output_ptrs {};
    for (uint32_t deck = 0; deck < kDecks; ++deck) {
        for (uint32_t channel = 0; channel < kInputChannels; ++channel) {
            input_ptrs[deck][channel] = input[deck][channel].data();
        }
        for (uint32_t channel = 0; channel < kOutputChannels; ++channel) {
            output_ptrs[deck][channel] = output[deck][channel].data();
        }
    }

    for (uint64_t warmup = 0; warmup < 32; ++warmup) {
        fillInput(input, warmup);
        separator.process(input_ptrs, output_ptrs);
    }

    std::vector<double> service;
    std::vector<double> completion;
    service.reserve(hops);
    completion.reserve(hops);
    uint64_t deadline_misses = 0;
    uint64_t non_finite = 0;
    double checksum = 0.0;
    const double cpu_start = cpuSeconds();
    const auto wall_start = Clock::now();
    const auto base = wall_start + std::chrono::milliseconds(100);
    for (uint64_t hop = 0; hop < hops; ++hop) {
        fillInput(input, hop + 32);
        const auto release = base + std::chrono::duration_cast<Clock::duration>(
            std::chrono::duration<double, std::milli>(kDeadlineMs * static_cast<double>(hop)));
        std::this_thread::sleep_until(release);
        const auto service_start = Clock::now();
        separator.process(input_ptrs, output_ptrs);
        const auto ended = Clock::now();
        service.push_back(std::chrono::duration<double, std::milli>(ended - service_start).count());
        completion.push_back(std::chrono::duration<double, std::milli>(ended - base).count());
        const auto deadline = release + std::chrono::duration_cast<Clock::duration>(
            std::chrono::duration<double, std::milli>(kDeadlineMs));
        deadline_misses += static_cast<uint64_t>(ended > deadline);
        for (const auto& deck : output) {
            for (const auto& channel : deck) {
                for (const float value : channel) {
                    non_finite += static_cast<uint64_t>(!std::isfinite(value));
                    checksum += std::isfinite(value) ? value : 0.0;
                }
            }
        }
    }
    const double wall_seconds = elapsedMs(wall_start) / 1'000.0;
    const double cpu_percent = 100.0 * (cpuSeconds() - cpu_start) / wall_seconds;
    const auto service_distribution = distribution(service);
    std::vector<double> completion_from_release;
    completion_from_release.reserve(hops);
    for (uint64_t hop = 0; hop < hops; ++hop) {
        completion_from_release.push_back(
            completion[hop] - static_cast<double>(hop) * kDeadlineMs);
    }
    const auto completion_distribution = distribution(completion_from_release);
    const auto ring = simulateRing(completion, 250.0);

    std::cout << std::fixed << std::setprecision(6);
    std::cout << "{\n  \"command\":\"dual-shared-graph\",\n"
              << "  \"sample_rate\":44100,\n  \"hop_samples\":512,\n"
              << "  \"deadline_ms\":" << kDeadlineMs << ",\n"
              << "  \"decks\":2,\n  \"hops\":" << hops << ",\n"
              << "  \"create_ms\":" << create_ms << ",\n  \"arm_ms\":" << arm_ms << ",\n"
              << "  \"rss_bytes\":{\"before\":" << rss_before << ",\"armed\":"
              << rss_armed << "},\n  \"wall_seconds\":" << wall_seconds
              << ",\n  \"cpu_percent\":" << cpu_percent << ",\n  \"batch_service_ms\":";
    printDistribution(service_distribution);
    std::cout << ",\n  \"completion_from_release_ms\":";
    printDistribution(completion_distribution);
    std::cout << ",\n  \"deadline_misses\":" << deadline_misses
              << ",\n  \"simulated_250ms_ring_starved_hops\":" << ring.starved_hops
              << ",\n  \"simulated_250ms_ring_underrun_transitions\":"
              << ring.underrun_transitions << ",\n  \"non_finite_samples\":" << non_finite
              << ",\n  \"output_checksum\":" << checksum << "\n}\n";
    return non_finite == 0 ? 0 : 1;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2 && argc != 3) {
        std::cerr << "usage: rt3s-dual-graph-bench PARAMS [HOPS]\n";
        return 2;
    }
    try {
        return run(argv[1], argc == 3 ? std::stoull(argv[2]) : 1'000);
    }
    catch (const std::exception& error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
