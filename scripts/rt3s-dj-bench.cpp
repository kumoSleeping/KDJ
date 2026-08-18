// Standalone research harness for the pinned GPU Audio RT3S implementation.
//
// This file intentionally depends only on RT3SLib's public interface. It is not linked into KDJ
// and must not be shipped: RT3S source and model artifacts are research/non-commercial assets.

#include <SoundSourceSepInterface.h>

#include <algorithm>
#include <array>
#include <barrier>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <numbers>
#include <numeric>
#include <stdexcept>
#include <string>
#include <string_view>
#include <sys/resource.h>
#include <thread>
#include <type_traits>
#include <vector>

#if defined(__APPLE__)
#include <mach/mach.h>
#endif

namespace {

using Clock = std::chrono::steady_clock;

constexpr std::size_t kInputChannels = 2;
constexpr std::size_t kOutputChannels = 8;
constexpr std::size_t kSources = 4;
constexpr std::size_t kHop = 512;
constexpr double kSampleRate = 44'100.0;
constexpr double kDeadlineMs = 1'000.0 * static_cast<double>(kHop) / kSampleRate;
constexpr std::array<std::string_view, kSources> kSourceNames = {
    "drums", "bass", "vocals", "other"};

using InputBlock = std::array<std::array<float, kHop>, kInputChannels>;
using OutputBlock = std::array<std::array<float, kHop>, kOutputChannels>;

struct Audio {
    std::array<std::vector<float>, kInputChannels> channels;

    [[nodiscard]] std::size_t frames() const {
        return std::min(channels[0].size(), channels[1].size());
    }

    [[nodiscard]] std::size_t hops() const { return frames() / kHop; }
};

struct CpuTimes {
    double user_seconds {};
    double system_seconds {};
};

struct Distribution {
    double mean {};
    double p50 {};
    double p95 {};
    double p99 {};
    double maximum {};
};

[[nodiscard]] double milliseconds(Clock::duration elapsed) {
    return std::chrono::duration<double, std::milli>(elapsed).count();
}

[[nodiscard]] CpuTimes cpuTimes() {
    rusage usage {};
    if (getrusage(RUSAGE_SELF, &usage) != 0) {
        throw std::runtime_error("getrusage failed");
    }
    const auto seconds = [](const timeval& value) {
        return static_cast<double>(value.tv_sec) + static_cast<double>(value.tv_usec) / 1e6;
    };
    return {seconds(usage.ru_utime), seconds(usage.ru_stime)};
}

[[nodiscard]] std::uint64_t residentBytes() {
#if defined(__APPLE__)
    task_vm_info_data_t info {};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO,
            reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS) {
        return info.phys_footprint;
    }
#endif
    rusage usage {};
    if (getrusage(RUSAGE_SELF, &usage) != 0) {
        return 0;
    }
#if defined(__APPLE__)
    return static_cast<std::uint64_t>(usage.ru_maxrss);
#else
    return static_cast<std::uint64_t>(usage.ru_maxrss) * 1024;
#endif
}

[[nodiscard]] double percentile(const std::vector<double>& sorted, double fraction) {
    if (sorted.empty()) {
        return 0.0;
    }
    const double index = fraction * static_cast<double>(sorted.size() - 1);
    const auto lower = static_cast<std::size_t>(std::floor(index));
    const auto upper = static_cast<std::size_t>(std::ceil(index));
    const double mix = index - static_cast<double>(lower);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * mix;
}

[[nodiscard]] Distribution distribution(std::vector<double> samples) {
    if (samples.empty()) {
        return {};
    }
    const double mean = std::accumulate(samples.begin(), samples.end(), 0.0)
        / static_cast<double>(samples.size());
    std::sort(samples.begin(), samples.end());
    return {
        mean,
        percentile(samples, 0.50),
        percentile(samples, 0.95),
        percentile(samples, 0.99),
        samples.back(),
    };
}

void printDistribution(const Distribution& value) {
    std::cout << "{\"mean\":" << value.mean << ",\"p50\":" << value.p50
              << ",\"p95\":" << value.p95 << ",\"p99\":" << value.p99
              << ",\"max\":" << value.maximum << '}';
}

[[nodiscard]] std::size_t parseSize(const char* text, std::string_view name) {
    std::size_t consumed = 0;
    const std::string value(text);
    const auto parsed = std::stoull(value, &consumed);
    if (consumed != value.size()) {
        throw std::runtime_error(std::string(name) + " must be an integer");
    }
    return static_cast<std::size_t>(parsed);
}

[[nodiscard]] bool parseMode(const char* text) {
    const std::string_view mode(text);
    if (mode == "async") {
        return true;
    }
    if (mode == "sync") {
        return false;
    }
    throw std::runtime_error("mode must be sync or async");
}

[[nodiscard]] Audio readRawStereo(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary | std::ios::ate);
    if (!stream) {
        throw std::runtime_error("cannot open raw stereo input: " + path.string());
    }
    const auto size = stream.tellg();
    if (size < 0 || (size % static_cast<std::streamoff>(sizeof(float) * 2)) != 0) {
        throw std::runtime_error("raw input must be interleaved stereo float32");
    }
    stream.seekg(0);
    std::vector<float> interleaved(static_cast<std::size_t>(size) / sizeof(float));
    stream.read(reinterpret_cast<char*>(interleaved.data()), size);
    if (!stream) {
        throw std::runtime_error("failed to read raw stereo input");
    }
    Audio audio;
    const auto frames = interleaved.size() / 2;
    audio.channels[0].resize(frames);
    audio.channels[1].resize(frames);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        audio.channels[0][frame] = interleaved[frame * 2];
        audio.channels[1][frame] = interleaved[frame * 2 + 1];
    }
    return audio;
}

[[nodiscard]] Audio deterministicAudio(std::size_t hops) {
    Audio audio;
    const auto frames = std::max<std::size_t>(hops, 1) * kHop;
    for (auto& channel : audio.channels) {
        channel.resize(frames);
    }
    for (std::size_t frame = 0; frame < frames; ++frame) {
        const auto t = static_cast<double>(frame) / kSampleRate;
        audio.channels[0][frame] = static_cast<float>(
            0.31 * std::sin(2.0 * std::numbers::pi * 110.0 * t)
            + 0.17 * std::sin(2.0 * std::numbers::pi * 997.0 * t));
        audio.channels[1][frame] = static_cast<float>(
            0.29 * std::sin(2.0 * std::numbers::pi * 147.0 * t)
            + 0.19 * std::sin(2.0 * std::numbers::pi * 1'313.0 * t));
    }
    return audio;
}

void processHop(SoundSourceSepInterface& separator, const Audio& audio, std::size_t hop,
    OutputBlock& output) {
    if (audio.hops() == 0) {
        throw std::runtime_error("audio has no complete 512-sample hop");
    }
    const auto wrapped_hop = hop % audio.hops();
    const auto offset = wrapped_hop * kHop;
    std::array<const float*, kInputChannels> input {
        audio.channels[0].data() + offset,
        audio.channels[1].data() + offset,
    };
    std::array<float*, kOutputChannels> output_ptrs {};
    for (std::size_t channel = 0; channel < kOutputChannels; ++channel) {
        output_ptrs[channel] = output[channel].data();
    }
    separator.process(input.data(), output_ptrs.data(), static_cast<int>(kHop));
}

[[nodiscard]] std::size_t nonFinite(const OutputBlock& output) {
    std::size_t count = 0;
    for (const auto& channel : output) {
        count += static_cast<std::size_t>(std::count_if(channel.begin(), channel.end(),
            [](float sample) { return !std::isfinite(sample); }));
    }
    return count;
}

[[nodiscard]] double checksum(const OutputBlock& output) {
    double result = 0.0;
    for (const auto& channel : output) {
        for (const float sample : channel) {
            result += static_cast<double>(sample);
        }
    }
    return result;
}

struct DeckStats {
    std::vector<double> service_ms;
    std::vector<double> completion_ms;
    std::size_t deadline_misses {};
    std::size_t non_finite {};
    double checksum {};
};

struct RingSimulation {
    std::size_t starved_hops {};
    std::size_t underrun_transitions {};
};

[[nodiscard]] RingSimulation simulateOutputRing(const std::vector<double>& completion_ms,
    double initial_cushion_ms) {
    RingSimulation result;
    bool starved = false;
    for (const double lag : completion_ms) {
        const bool now_starved = lag > initial_cushion_ms;
        result.starved_hops += now_starved;
        result.underrun_transitions += now_starved && !starved;
        starved = now_starved;
    }
    return result;
}

int runBench(int argc, char** argv) {
    if (argc < 7 || argc > 8) {
        throw std::runtime_error(
            "bench usage: rt3s-dj-bench bench PARAMS DECKS HOPS sync|async serial|parallel [stereo.f32le]");
    }
    const std::filesystem::path params(argv[2]);
    const auto deck_count = parseSize(argv[3], "decks");
    const auto hop_count = parseSize(argv[4], "hops");
    const bool asynchronous = parseMode(argv[5]);
    const std::string_view scheduling(argv[6]);
    if (deck_count == 0 || hop_count == 0) {
        throw std::runtime_error("decks and hops must be greater than zero");
    }
    if (scheduling != "serial" && scheduling != "parallel") {
        throw std::runtime_error("scheduling must be serial or parallel");
    }
    Audio audio = argc == 8 ? readRawStereo(argv[7]) : deterministicAudio(hop_count + 64);
    if (audio.hops() == 0) {
        throw std::runtime_error("input has no complete hop");
    }

    const auto rss_before = residentBytes();
    std::vector<std::unique_ptr<SoundSourceSepInterface>> separators;
    std::vector<double> create_ms;
    std::vector<double> arm_ms;
    separators.reserve(deck_count);
    for (std::size_t deck = 0; deck < deck_count; ++deck) {
        const auto create_start = Clock::now();
        auto separator = createGpuProcessor(params.c_str(), asynchronous);
        if (!separator) {
            throw std::runtime_error("createGpuProcessor returned null");
        }
        create_ms.push_back(milliseconds(Clock::now() - create_start));
        const auto arm_start = Clock::now();
        separator->arm();
        arm_ms.push_back(milliseconds(Clock::now() - arm_start));
        separators.push_back(std::move(separator));
    }
    const auto rss_armed = residentBytes();

    constexpr std::size_t warmup_hops = 32;
    for (std::size_t hop = 0; hop < warmup_hops; ++hop) {
        for (auto& separator : separators) {
            OutputBlock output {};
            processHop(*separator, audio, hop, output);
        }
    }

    std::vector<DeckStats> stats(deck_count);
    for (auto& deck : stats) {
        deck.service_ms.reserve(hop_count);
        deck.completion_ms.reserve(hop_count);
    }
    const auto cpu_start = cpuTimes();
    const auto wall_start = Clock::now();
    const auto base = wall_start + std::chrono::milliseconds(100);
    const auto deadline = std::chrono::duration<double, std::milli>(kDeadlineMs);

    if (scheduling == "parallel") {
        std::barrier start_barrier(static_cast<std::ptrdiff_t>(deck_count));
        std::vector<std::thread> workers;
        workers.reserve(deck_count);
        for (std::size_t deck = 0; deck < deck_count; ++deck) {
            workers.emplace_back([&, deck] {
                OutputBlock output {};
                start_barrier.arrive_and_wait();
                for (std::size_t hop = 0; hop < hop_count; ++hop) {
                    const auto release = base + std::chrono::duration_cast<Clock::duration>(
                        deadline * static_cast<double>(hop));
                    std::this_thread::sleep_until(release);
                    const auto service_start = Clock::now();
                    processHop(*separators[deck], audio, warmup_hops + hop, output);
                    const auto completed = Clock::now();
                    stats[deck].service_ms.push_back(milliseconds(completed - service_start));
                    stats[deck].completion_ms.push_back(milliseconds(completed - release));
                    stats[deck].deadline_misses += completed > release + deadline;
                    stats[deck].non_finite += nonFinite(output);
                    stats[deck].checksum += checksum(output);
                }
            });
        }
        for (auto& worker : workers) {
            worker.join();
        }
    } else {
        std::vector<OutputBlock> outputs(deck_count);
        for (std::size_t hop = 0; hop < hop_count; ++hop) {
            const auto release = base + std::chrono::duration_cast<Clock::duration>(
                deadline * static_cast<double>(hop));
            std::this_thread::sleep_until(release);
            for (std::size_t deck = 0; deck < deck_count; ++deck) {
                const auto service_start = Clock::now();
                processHop(*separators[deck], audio, warmup_hops + hop, outputs[deck]);
                const auto completed = Clock::now();
                stats[deck].service_ms.push_back(milliseconds(completed - service_start));
                stats[deck].completion_ms.push_back(milliseconds(completed - release));
                stats[deck].deadline_misses += completed > release + deadline;
                stats[deck].non_finite += nonFinite(outputs[deck]);
                stats[deck].checksum += checksum(outputs[deck]);
            }
        }
    }
    const auto wall_end = Clock::now();
    const auto cpu_end = cpuTimes();
    const auto rss_after = residentBytes();

    const double wall_seconds = std::chrono::duration<double>(wall_end - wall_start).count();
    const double cpu_seconds = (cpu_end.user_seconds - cpu_start.user_seconds)
        + (cpu_end.system_seconds - cpu_start.system_seconds);

    std::cout << std::fixed << std::setprecision(6);
    std::cout << "{\n  \"command\":\"bench\",\n  \"sample_rate\":44100,\n"
              << "  \"hop_samples\":512,\n  \"deadline_ms\":" << kDeadlineMs << ",\n"
              << "  \"mode\":\"" << (asynchronous ? "async" : "sync") << "\",\n"
              << "  \"scheduling\":\"" << scheduling << "\",\n"
              << "  \"decks\":" << deck_count << ",\n  \"hops\":" << hop_count << ",\n"
              << "  \"create_ms\":[";
    for (std::size_t index = 0; index < create_ms.size(); ++index) {
        if (index != 0) std::cout << ',';
        std::cout << create_ms[index];
    }
    std::cout << "],\n  \"arm_ms\":[";
    for (std::size_t index = 0; index < arm_ms.size(); ++index) {
        if (index != 0) std::cout << ',';
        std::cout << arm_ms[index];
    }
    std::cout << "],\n  \"rss_bytes\":{\"before\":" << rss_before
              << ",\"armed\":" << rss_armed << ",\"after\":" << rss_after << "},\n"
              << "  \"wall_seconds\":" << wall_seconds << ",\n"
              << "  \"cpu_seconds\":" << cpu_seconds << ",\n"
              << "  \"cpu_percent\":"
              << (wall_seconds > 0.0 ? cpu_seconds / wall_seconds * 100.0 : 0.0) << ",\n"
              << "  \"decks_result\":[\n";
    for (std::size_t deck = 0; deck < deck_count; ++deck) {
        const auto ring = simulateOutputRing(stats[deck].completion_ms, 250.0);
        std::cout << "    {\"deck\":" << deck << ",\"service_ms\":";
        printDistribution(distribution(stats[deck].service_ms));
        std::cout << ",\"completion_from_release_ms\":";
        printDistribution(distribution(stats[deck].completion_ms));
        std::cout << ",\"deadline_misses\":" << stats[deck].deadline_misses
                  << ",\"simulated_250ms_ring_starved_hops\":" << ring.starved_hops
                  << ",\"simulated_250ms_ring_underrun_transitions\":"
                  << ring.underrun_transitions
                  << ",\"non_finite_samples\":" << stats[deck].non_finite
                  << ",\"output_checksum\":" << stats[deck].checksum << '}';
        std::cout << (deck + 1 == deck_count ? "\n" : ",\n");
    }
    std::cout << "  ]\n}\n";
    return 0;
}

struct Difference {
    double sdr_db {};
    double normalized_rmse {};
};

[[nodiscard]] Difference compare(const OutputBlock& reference, const OutputBlock& candidate) {
    long double reference_energy = 0.0;
    long double error_energy = 0.0;
    for (std::size_t channel = 0; channel < kOutputChannels; ++channel) {
        for (std::size_t sample = 0; sample < kHop; ++sample) {
            const long double expected = reference[channel][sample];
            const long double error = expected - candidate[channel][sample];
            reference_energy += expected * expected;
            error_energy += error * error;
        }
    }
    constexpr long double epsilon = 1e-20L;
    const double sdr = 10.0 * std::log10(static_cast<double>(
        (reference_energy + epsilon) / (error_energy + epsilon)));
    const double nrmse = std::sqrt(static_cast<double>(
        error_energy / (reference_energy + epsilon)));
    return {std::min(sdr, 200.0), nrmse};
}

[[nodiscard]] std::size_t firstThreshold(const std::vector<double>& values, double threshold,
    std::size_t consecutive) {
    if (consecutive == 0 || values.size() < consecutive) {
        return values.size();
    }
    for (std::size_t start = 0; start + consecutive <= values.size(); ++start) {
        bool passes = true;
        for (std::size_t offset = 0; offset < consecutive; ++offset) {
            passes = passes && values[start + offset] >= threshold;
        }
        if (passes) {
            return start;
        }
    }
    return values.size();
}

int runSeek(int argc, char** argv) {
    if (argc != 6) {
        throw std::runtime_error(
            "seek usage: rt3s-dj-bench seek PARAMS stereo.f32le TARGET_HOP EVAL_HOPS");
    }
    const std::filesystem::path params(argv[2]);
    const Audio audio = readRawStereo(argv[3]);
    const auto target_hop = parseSize(argv[4], "target hop");
    const auto eval_hops = parseSize(argv[5], "evaluation hops");
    if (eval_hops == 0 || target_hop + eval_hops > audio.hops()) {
        throw std::runtime_error("seek target/evaluation range is outside the PCM cache");
    }

    const auto create_start = Clock::now();
    auto separator = createGpuProcessor(params.c_str(), false);
    if (!separator) {
        throw std::runtime_error("createGpuProcessor returned null");
    }
    const double create_ms = milliseconds(Clock::now() - create_start);
    const auto arm_start = Clock::now();
    separator->arm();
    const double initial_arm_ms = milliseconds(Clock::now() - arm_start);

    std::vector<OutputBlock> reference(eval_hops);
    OutputBlock scratch {};
    const auto reference_start = Clock::now();
    for (std::size_t hop = 0; hop < target_hop + eval_hops; ++hop) {
        if (hop >= target_hop) {
            processHop(*separator, audio, hop, reference[hop - target_hop]);
        } else {
            processHop(*separator, audio, hop, scratch);
        }
    }
    const double reference_ms = milliseconds(Clock::now() - reference_start);

    constexpr std::array<std::size_t, 6> requested_preroll_ms {0, 50, 100, 250, 500, 1'000};
    std::cout << std::fixed << std::setprecision(6);
    std::cout << "{\n  \"command\":\"seek\",\n  \"sample_rate\":44100,\n"
              << "  \"hop_samples\":512,\n  \"deadline_ms\":" << kDeadlineMs << ",\n"
              << "  \"target_hop\":" << target_hop << ",\n"
              << "  \"target_ms\":" << static_cast<double>(target_hop * kHop) / kSampleRate * 1'000.0 << ",\n"
              << "  \"eval_hops\":" << eval_hops << ",\n"
              << "  \"create_ms\":" << create_ms << ",\n"
              << "  \"initial_arm_ms\":" << initial_arm_ms << ",\n"
              << "  \"continuous_reference_ms\":" << reference_ms << ",\n"
              << "  \"thresholds\":{\"first_audible_proxy_sdr_db\":10.0,"
                 "\"fully_stable_proxy_sdr_db\":30.0,\"stable_consecutive_hops\":5},\n"
              << "  \"cases\":[\n";

    for (std::size_t case_index = 0; case_index < requested_preroll_ms.size(); ++case_index) {
        const auto requested_ms = requested_preroll_ms[case_index];
        const auto preroll_hops = static_cast<std::size_t>(std::ceil(
            static_cast<double>(requested_ms) * kSampleRate / 1'000.0 / static_cast<double>(kHop)));
        const auto available_preroll = std::min(preroll_hops, target_hop);
        const auto start_hop = target_hop - available_preroll;

        const auto reset_start = Clock::now();
        separator->disarm();
        separator->arm();
        const double reset_ms = milliseconds(Clock::now() - reset_start);

        std::vector<OutputBlock> candidate(eval_hops);
        const auto inference_start = Clock::now();
        Clock::time_point first_completed {};
        for (std::size_t hop = start_hop; hop < target_hop + eval_hops; ++hop) {
            if (hop >= target_hop) {
                processHop(*separator, audio, hop, candidate[hop - target_hop]);
                if (hop == target_hop) {
                    first_completed = Clock::now();
                }
            } else {
                processHop(*separator, audio, hop, scratch);
            }
        }
        const auto inference_end = Clock::now();
        const double first_output_ms = reset_ms + milliseconds(first_completed - inference_start);
        const double total_inference_ms = milliseconds(inference_end - inference_start);

        std::vector<double> sdr;
        std::vector<double> nrmse;
        sdr.reserve(eval_hops);
        nrmse.reserve(eval_hops);
        for (std::size_t hop = 0; hop < eval_hops; ++hop) {
            const auto difference = compare(reference[hop], candidate[hop]);
            sdr.push_back(difference.sdr_db);
            nrmse.push_back(difference.normalized_rmse);
        }
        const auto audible_hop = firstThreshold(sdr, 10.0, 1);
        const auto stable_hop = firstThreshold(sdr, 30.0, 5);
        const auto hopToMs = [](std::size_t hop) {
            return hop * static_cast<double>(kHop) / kSampleRate * 1'000.0;
        };

        std::cout << "    {\"requested_preroll_ms\":" << requested_ms
                  << ",\"actual_preroll_hops\":" << available_preroll
                  << ",\"actual_preroll_ms\":" << hopToMs(available_preroll)
                  << ",\"reset_recreate_ms\":" << reset_ms
                  << ",\"hot_cue_to_first_output_ms\":" << first_output_ms
                  << ",\"case_inference_ms\":" << total_inference_ms
                  << ",\"first_hop_sdr_db\":" << sdr.front()
                  << ",\"first_hop_normalized_rmse\":" << nrmse.front()
                  << ",\"first_audible_proxy_hop\":";
        if (audible_hop == sdr.size()) std::cout << "null"; else std::cout << audible_hop;
        std::cout << ",\"first_audible_proxy_ms\":";
        if (audible_hop == sdr.size()) std::cout << "null"; else std::cout << hopToMs(audible_hop);
        std::cout << ",\"fully_stable_proxy_hop\":";
        if (stable_hop == sdr.size()) std::cout << "null"; else std::cout << stable_hop;
        std::cout << ",\"fully_stable_proxy_ms\":";
        if (stable_hop == sdr.size()) std::cout << "null"; else std::cout << hopToMs(stable_hop);
        std::cout << ",\"sdr_db_by_hop\":[";
        for (std::size_t hop = 0; hop < sdr.size(); ++hop) {
            if (hop != 0) std::cout << ',';
            std::cout << sdr[hop];
        }
        std::cout << "]}" << (case_index + 1 == requested_preroll_ms.size() ? "\n" : ",\n");
    }
    std::cout << "  ]\n}\n";
    return 0;
}

template <typename T>
void writeLittleEndian(std::ofstream& stream, T value) {
    static_assert(std::is_integral_v<T>);
    std::array<unsigned char, sizeof(T)> bytes {};
    for (std::size_t index = 0; index < sizeof(T); ++index) {
        bytes[index] = static_cast<unsigned char>((value >> (index * 8)) & 0xff);
    }
    stream.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

void writeFloatWav(const std::filesystem::path& path,
    const std::array<std::vector<float>, 2>& channels) {
    const auto frames = std::min(channels[0].size(), channels[1].size());
    const auto data_bytes = static_cast<std::uint32_t>(frames * 2 * sizeof(float));
    std::ofstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("cannot create WAV: " + path.string());
    }
    stream.write("RIFF", 4);
    writeLittleEndian<std::uint32_t>(stream, 36 + data_bytes);
    stream.write("WAVEfmt ", 8);
    writeLittleEndian<std::uint32_t>(stream, 16);
    writeLittleEndian<std::uint16_t>(stream, 3); // IEEE float
    writeLittleEndian<std::uint16_t>(stream, 2);
    writeLittleEndian<std::uint32_t>(stream, 44'100);
    writeLittleEndian<std::uint32_t>(stream, 44'100 * 2 * sizeof(float));
    writeLittleEndian<std::uint16_t>(stream, 2 * sizeof(float));
    writeLittleEndian<std::uint16_t>(stream, 32);
    stream.write("data", 4);
    writeLittleEndian<std::uint32_t>(stream, data_bytes);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        stream.write(reinterpret_cast<const char*>(&channels[0][frame]), sizeof(float));
        stream.write(reinterpret_cast<const char*>(&channels[1][frame]), sizeof(float));
    }
}

int runAudition(int argc, char** argv) {
    if (argc != 7) {
        throw std::runtime_error(
            "audition usage: rt3s-dj-bench audition PARAMS stereo.f32le OUTPUT_PREFIX START_HOP HOPS");
    }
    const std::filesystem::path params(argv[2]);
    const Audio audio = readRawStereo(argv[3]);
    const std::filesystem::path prefix(argv[4]);
    const auto start_hop = parseSize(argv[5], "start hop");
    const auto output_hops = parseSize(argv[6], "hops");
    if (output_hops == 0 || start_hop + output_hops > audio.hops()) {
        throw std::runtime_error("audition range is outside the PCM cache");
    }
    auto separator = createGpuProcessor(params.c_str(), false);
    if (!separator) {
        throw std::runtime_error("createGpuProcessor returned null");
    }
    separator->arm();
    std::array<std::array<std::vector<float>, 2>, kSources> rendered;
    for (auto& source : rendered) {
        for (auto& channel : source) channel.reserve(output_hops * kHop);
    }
    OutputBlock output {};
    const auto started = Clock::now();
    for (std::size_t hop = 0; hop < start_hop + output_hops; ++hop) {
        processHop(*separator, audio, hop, output);
        if (hop < start_hop) continue;
        for (std::size_t source = 0; source < kSources; ++source) {
            for (std::size_t channel = 0; channel < 2; ++channel) {
                const auto& block = output[source * 2 + channel];
                rendered[source][channel].insert(
                    rendered[source][channel].end(), block.begin(), block.end());
            }
        }
    }
    const double elapsed_ms = milliseconds(Clock::now() - started);
    for (std::size_t source = 0; source < kSources; ++source) {
        const auto path = prefix.string() + "-" + std::string(kSourceNames[source]) + ".wav";
        writeFloatWav(path, rendered[source]);
    }
    std::cout << std::fixed << std::setprecision(6)
              << "{\"command\":\"audition\",\"start_hop\":" << start_hop
              << ",\"hops\":" << output_hops << ",\"render_ms\":" << elapsed_ms
              << ",\"audio_ms\":" << static_cast<double>(output_hops * kHop) / kSampleRate * 1'000.0
              << ",\"prefix\":\"" << prefix.string() << "\"}\n";
    return 0;
}

void usage() {
    std::cerr
        << "RT3S DJ research harness\n\n"
        << "  rt3s-dj-bench bench PARAMS DECKS HOPS sync|async serial|parallel [stereo.f32le]\n"
        << "  rt3s-dj-bench seek PARAMS stereo.f32le TARGET_HOP EVAL_HOPS\n"
        << "  rt3s-dj-bench audition PARAMS stereo.f32le OUTPUT_PREFIX START_HOP HOPS\n";
}

} // namespace

int main(int argc, char** argv) try {
    if (argc < 2) {
        usage();
        return 2;
    }
    const std::string_view command(argv[1]);
    if (command == "bench") return runBench(argc, argv);
    if (command == "seek") return runSeek(argc, argv);
    if (command == "audition") return runAudition(argc, argv);
    usage();
    return 2;
} catch (const std::exception& error) {
    std::cerr << "rt3s-dj-bench: " << error.what() << '\n';
    return 1;
}
