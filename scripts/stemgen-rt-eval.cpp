// Isolated evaluator for the pinned StemgenRT HS-TasNet ONNX artifact.
//
// This is research tooling, not part of the KDJ application or its runtime.
// Build and invocation instructions live in docs/stemgen-rt-evaluation.md.

#include <onnxruntime_c_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <numeric>
#include <string>
#include <thread>
#include <vector>

#include <mach/mach.h>
#include <sys/resource.h>

namespace {

constexpr int kChannels = 2;
constexpr int kStems = 4;
constexpr int kContext = 1024;
constexpr int kOutputFrames = 512;
constexpr int kInputFrames = kContext + kOutputFrames + kContext;
constexpr double kSampleRate = 44100.0;
constexpr double kDeadlineMs = 1000.0 * kOutputFrames / kSampleRate;
constexpr std::array<const char*, kStems> kStemNames = {
    "drums", "bass", "vocals", "other"};

const OrtApi* api() { return OrtGetApiBase()->GetApi(ORT_API_VERSION); }

[[noreturn]] void fail(const std::string& context, OrtStatus* status = nullptr) {
  std::string message = context;
  if (status != nullptr) {
    message += ": ";
    message += api()->GetErrorMessage(status);
    api()->ReleaseStatus(status);
  }
  std::cerr << "error: " << message << '\n';
  std::exit(1);
}

void check(const std::string& context, OrtStatus* status) {
  if (status != nullptr) fail(context, status);
}

template <typename T>
using OrtPtr = std::unique_ptr<T, void (*)(T*)>;

using Env = OrtPtr<OrtEnv>;
using SessionOptions = OrtPtr<OrtSessionOptions>;
using Session = OrtPtr<OrtSession>;
using MemoryInfo = OrtPtr<OrtMemoryInfo>;
using Value = OrtPtr<OrtValue>;

double msSince(const std::chrono::steady_clock::time_point& start) {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now() - start)
      .count();
}

double cpuSeconds() {
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
  return usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6 +
         usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
}

uint64_t rssBytes() {
  mach_task_basic_info info{};
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
                reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS) {
    return 0;
  }
  return info.resident_size;
}

double percentile(std::vector<double> samples, double fraction) {
  if (samples.empty()) return 0.0;
  std::sort(samples.begin(), samples.end());
  const double position = fraction * static_cast<double>(samples.size() - 1);
  const auto lo = static_cast<size_t>(std::floor(position));
  const auto hi = static_cast<size_t>(std::ceil(position));
  return samples[lo] + (samples[hi] - samples[lo]) * (position - lo);
}

void printLatency(const std::vector<double>& samples, const std::string& label) {
  const auto [minimum, maximum] = std::minmax_element(samples.begin(), samples.end());
  const double mean = std::accumulate(samples.begin(), samples.end(), 0.0) /
                      static_cast<double>(samples.size());
  std::cout << label << " n=" << samples.size() << " mean_ms=" << mean
            << " min_ms=" << *minimum << " p50_ms=" << percentile(samples, 0.50)
            << " p95_ms=" << percentile(samples, 0.95)
            << " p99_ms=" << percentile(samples, 0.99)
            << " max_ms=" << *maximum << '\n';
}

struct Runtime {
  Env env{nullptr, api()->ReleaseEnv};
  MemoryInfo memory{nullptr, api()->ReleaseMemoryInfo};

  Runtime() {
    OrtEnv* raw_env = nullptr;
    check("CreateEnv", api()->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "kdj-stemgen-eval", &raw_env));
    env.reset(raw_env);
    OrtMemoryInfo* raw_memory = nullptr;
    check("CreateCpuMemoryInfo", api()->CreateCpuMemoryInfo(
                                      OrtArenaAllocator, OrtMemTypeDefault, &raw_memory));
    memory.reset(raw_memory);
  }

  Session makeSession(const std::string& model) const {
    OrtSessionOptions* raw_options = nullptr;
    check("CreateSessionOptions", api()->CreateSessionOptions(&raw_options));
    SessionOptions options(raw_options, api()->ReleaseSessionOptions);
    check("SetSessionGraphOptimizationLevel",
          api()->SetSessionGraphOptimizationLevel(options.get(), ORT_ENABLE_ALL));
    // This is exactly StemgenRT's CPU configuration on an eight-core M2.
    check("SetIntraOpNumThreads", api()->SetIntraOpNumThreads(options.get(), 4));
    check("SetInterOpNumThreads", api()->SetInterOpNumThreads(options.get(), 1));
    OrtSession* raw_session = nullptr;
    check("CreateSession", api()->CreateSession(env.get(), model.c_str(), options.get(), &raw_session));
    return Session(raw_session, api()->ReleaseSession);
  }

  Value run(const Session& session, const std::vector<float>& input) const {
    const std::array<int64_t, 3> shape = {1, kChannels, kInputFrames};
    OrtValue* raw_input = nullptr;
    check("CreateTensorWithDataAsOrtValue", api()->CreateTensorWithDataAsOrtValue(
                                               memory.get(), const_cast<float*>(input.data()),
                                               input.size() * sizeof(float), shape.data(), shape.size(),
                                               ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &raw_input));
    Value input_tensor(raw_input, api()->ReleaseValue);
    const char* input_name[] = {"audio"};
    const char* output_name[] = {"separated"};
    const OrtValue* inputs[] = {input_tensor.get()};
    OrtValue* raw_output = nullptr;
    check("Run", api()->Run(session.get(), nullptr, input_name, inputs, 1, output_name, 1, &raw_output));
    return Value(raw_output, api()->ReleaseValue);
  }
};

std::vector<float> deterministicInput() {
  std::vector<float> input(kChannels * kInputFrames);
  for (int channel = 0; channel < kChannels; ++channel) {
    for (int frame = 0; frame < kInputFrames; ++frame) {
      const double time = static_cast<double>(frame) / kSampleRate;
      input[channel * kInputFrames + frame] = static_cast<float>(
          0.30 * std::sin(2.0 * M_PI * (55.0 + 10.0 * channel) * time) +
          0.20 * std::sin(2.0 * M_PI * (220.0 + 110.0 * channel) * time) +
          0.10 * std::sin(2.0 * M_PI * (880.0 + 440.0 * channel) * time));
    }
  }
  return input;
}

struct Wav {
  int sample_rate = 0;
  int channels = 0;
  std::vector<float> samples;
};

int reflectedIndex(int index, int frames) {
  while (index < 0 || index >= frames) index = index < 0 ? -index - 1 : 2 * frames - index - 1;
  return index;
}

std::vector<float> wavInput(const Wav& wav, int center) {
  const int frames = static_cast<int>(wav.samples.size() / kChannels);
  std::vector<float> input(kChannels * kInputFrames);
  for (int channel = 0; channel < kChannels; ++channel) {
    for (int frame = 0; frame < kInputFrames; ++frame) {
      const int source_frame = reflectedIndex(center + frame - kContext, frames);
      input[channel * kInputFrames + frame] = wav.samples[source_frame * kChannels + channel];
    }
  }
  return input;
}

void assertOutputShape(const Value& output) {
  OrtTensorTypeAndShapeInfo* raw_info = nullptr;
  check("GetTensorTypeAndShape", api()->GetTensorTypeAndShape(output.get(), &raw_info));
  std::unique_ptr<OrtTensorTypeAndShapeInfo, decltype(api()->ReleaseTensorTypeAndShapeInfo)> info(
      raw_info, api()->ReleaseTensorTypeAndShapeInfo);
  std::array<int64_t, 4> shape{};
  check("GetDimensions", api()->GetDimensions(info.get(), shape.data(), shape.size()));
  if (shape != std::array<int64_t, 4>{1, kStems, kChannels, kInputFrames}) {
    fail("unexpected output shape");
  }
}

void benchmark(const std::string& model, int decks, int iterations, const Wav* wav = nullptr) {
  const auto process_start = std::chrono::steady_clock::now();
  const auto env_start = std::chrono::steady_clock::now();
  Runtime runtime;
  const double environment_ms = msSince(env_start);
  const auto load_start = std::chrono::steady_clock::now();
  std::vector<Session> sessions;
  sessions.reserve(decks);
  for (int deck = 0; deck < decks; ++deck) sessions.push_back(runtime.makeSession(model));
  const double session_load_ms = msSince(load_start);
  const auto input = wav == nullptr ? deterministicInput() : wavInput(*wav, 0);

  const auto first_start = std::chrono::steady_clock::now();
  auto first_output = runtime.run(sessions.front(), input);
  assertOutputShape(first_output);
  const double first_run_ms = msSince(first_start);
  const double process_to_first_output_ms = msSince(process_start);

  // Prime allocators and convolution kernels before measuring steady-state work.
  for (int deck = 0; deck < decks; ++deck) (void)runtime.run(sessions[deck], input);

  std::vector<std::vector<double>> samples(static_cast<size_t>(decks));
  std::vector<int> missed(static_cast<size_t>(decks));
  std::mutex start_mutex;
  std::condition_variable start_cv;
  int ready = 0;
  bool begin = false;
  const auto cpu_start = cpuSeconds();
  const auto wall_start = std::chrono::steady_clock::now();
  const auto base = wall_start + std::chrono::milliseconds(40);
  std::vector<std::thread> workers;
  workers.reserve(decks);
  for (int deck = 0; deck < decks; ++deck) {
    workers.emplace_back([&, deck] {
      {
        std::unique_lock lock(start_mutex);
        ++ready;
        start_cv.notify_all();
        start_cv.wait(lock, [&] { return begin; });
      }
      auto current_input = input;
      for (int iteration = 0; iteration < iterations; ++iteration) {
        const auto release = base + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                        std::chrono::duration<double, std::milli>(kDeadlineMs * iteration));
        std::this_thread::sleep_until(release);
        const auto began = std::chrono::steady_clock::now();
        if (wav != nullptr) {
          const int frames = static_cast<int>(wav->samples.size() / kChannels);
          const int center = static_cast<int>(
              (static_cast<int64_t>(iteration) * kOutputFrames) % frames);
          current_input = wavInput(*wav, center);
        }
        (void)runtime.run(sessions[deck], current_input);
        const auto ended = std::chrono::steady_clock::now();
        samples[deck].push_back(std::chrono::duration<double, std::milli>(ended - began).count());
        const auto deadline = release + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                            std::chrono::duration<double, std::milli>(kDeadlineMs));
        if (ended > deadline) ++missed[deck];
      }
    });
  }
  {
    std::unique_lock lock(start_mutex);
    start_cv.wait(lock, [&] { return ready == decks; });
    begin = true;
  }
  start_cv.notify_all();
  for (auto& worker : workers) worker.join();
  const double wall_seconds = msSince(wall_start) / 1000.0;
  const double cpu_percent = 100.0 * (cpuSeconds() - cpu_start) / wall_seconds;

  std::cout << std::fixed << std::setprecision(3);
  std::cout << "ort_version=" << OrtGetApiBase()->GetVersionString()
            << " provider=CPU decks=" << decks << " intra_threads=4 inter_threads=1"
            << " chunk_frames=" << kOutputFrames << " chunk_deadline_ms=" << kDeadlineMs
            << " input=" << (wav == nullptr ? "deterministic" : "wav") << '\n';
  std::cout << "cold_environment_ms=" << environment_ms
            << " cold_session_load_ms=" << session_load_ms
            << " cold_first_run_ms=" << first_run_ms
            << " cold_process_to_first_output_ms=" << process_to_first_output_ms << '\n';
  for (int deck = 0; deck < decks; ++deck) {
    printLatency(samples[deck], "deck_" + std::to_string(deck + 1));
    std::cout << "deck_" << deck + 1 << " deadline_misses=" << missed[deck]
              << '/' << iterations << '\n';
  }
  std::cout << "rss_mib=" << static_cast<double>(rssBytes()) / (1024.0 * 1024.0)
            << " paced_wall_s=" << wall_seconds << " process_cpu_percent=" << cpu_percent << '\n';
}

uint32_t readU32(std::istream& stream) {
  std::array<unsigned char, 4> bytes{};
  stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
}

uint16_t readU16(std::istream& stream) {
  std::array<unsigned char, 2> bytes{};
  stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
  return static_cast<uint16_t>(bytes[0] | (bytes[1] << 8));
}

Wav readWav16(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  std::array<char, 4> tag{};
  stream.read(tag.data(), tag.size());
  if (std::string(tag.data(), 4) != "RIFF") fail("not a RIFF WAV: " + path);
  (void)readU32(stream);
  stream.read(tag.data(), tag.size());
  if (std::string(tag.data(), 4) != "WAVE") fail("not a WAVE file: " + path);
  int channels = 0;
  int rate = 0;
  int bits = 0;
  std::vector<int16_t> pcm;
  while (stream.read(tag.data(), tag.size())) {
    const uint32_t bytes = readU32(stream);
    const std::string chunk(tag.data(), 4);
    if (chunk == "fmt ") {
      if (readU16(stream) != 1) fail("WAV must use PCM16");
      channels = readU16(stream);
      rate = static_cast<int>(readU32(stream));
      (void)readU32(stream);
      (void)readU16(stream);
      bits = readU16(stream);
      stream.seekg(bytes - 16, std::ios::cur);
    } else if (chunk == "data") {
      if (bytes % 2 != 0) fail("invalid PCM16 data length");
      pcm.resize(bytes / 2);
      stream.read(reinterpret_cast<char*>(pcm.data()), bytes);
    } else {
      stream.seekg(bytes + (bytes & 1), std::ios::cur);
    }
  }
  if (channels != 2 || rate != 44100 || bits != 16 || pcm.empty()) {
    fail("input must be non-empty 44.1kHz stereo PCM16 WAV");
  }
  Wav wav{rate, channels, {}};
  wav.samples.reserve(pcm.size());
  for (const auto sample : pcm) wav.samples.push_back(sample / 32768.0f);
  return wav;
}

void writeU16(std::ostream& stream, uint16_t value) {
  stream.put(static_cast<char>(value & 0xff));
  stream.put(static_cast<char>((value >> 8) & 0xff));
}

void writeU32(std::ostream& stream, uint32_t value) {
  for (int byte = 0; byte < 4; ++byte) stream.put(static_cast<char>((value >> (byte * 8)) & 0xff));
}

void writeWav16(const std::string& path, const std::vector<float>& samples) {
  std::ofstream stream(path, std::ios::binary);
  const uint32_t data_bytes = static_cast<uint32_t>(samples.size() * sizeof(int16_t));
  stream.write("RIFF", 4); writeU32(stream, 36 + data_bytes); stream.write("WAVE", 4);
  stream.write("fmt ", 4); writeU32(stream, 16); writeU16(stream, 1); writeU16(stream, 2);
  writeU32(stream, 44100); writeU32(stream, 44100 * 2 * sizeof(int16_t));
  writeU16(stream, 2 * sizeof(int16_t)); writeU16(stream, 16);
  stream.write("data", 4); writeU32(stream, data_bytes);
  for (const float sample : samples) {
    const auto clipped = std::clamp(sample, -1.0f, 0.9999695f);
    writeU16(stream, static_cast<uint16_t>(std::lrint(clipped * 32768.0f)));
  }
}

void separate(const std::string& model, const std::string& source, const std::string& output_prefix) {
  const Wav wav = readWav16(source);
  const int frames = static_cast<int>(wav.samples.size() / kChannels);
  std::array<std::vector<float>, kStems> stems;
  for (auto& stem : stems) stem.resize(wav.samples.size());
  Runtime runtime;
  const auto session = runtime.makeSession(model);
  for (int center = 0; center < frames; center += kOutputFrames) {
    std::vector<float> input(kChannels * kInputFrames);
    for (int channel = 0; channel < kChannels; ++channel) {
      for (int frame = 0; frame < kInputFrames; ++frame) {
        const int source_frame = reflectedIndex(center + frame - kContext, frames);
        input[channel * kInputFrames + frame] = wav.samples[source_frame * kChannels + channel];
      }
    }
    const Value output = runtime.run(session, input);
    assertOutputShape(output);
    float* output_data = nullptr;
    check("GetTensorMutableData", api()->GetTensorMutableData(output.get(), reinterpret_cast<void**>(&output_data)));
    const int copied = std::min(kOutputFrames, frames - center);
    for (int stem = 0; stem < kStems; ++stem) {
      for (int channel = 0; channel < kChannels; ++channel) {
        const size_t base = (stem * kChannels + channel) * kInputFrames + kContext;
        for (int frame = 0; frame < copied; ++frame) {
          stems[stem][(center + frame) * kChannels + channel] = output_data[base + frame];
        }
      }
    }
  }
  for (int stem = 0; stem < kStems; ++stem) {
    writeWav16(output_prefix + "-" + kStemNames[stem] + ".wav", stems[stem]);
  }
}

void usage() {
  std::cerr << "usage:\n"
            << "  stemgen-rt-eval bench MODEL.onnx [decks] [iterations]\n"
            << "  stemgen-rt-eval bench-wav MODEL.onnx INPUT-44k1-stereo-pcm16.wav [iterations]\n"
            << "  stemgen-rt-eval separate MODEL.onnx INPUT-44k1-stereo-pcm16.wav OUTPUT-PREFIX\n";
  std::exit(2);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) usage();
  const std::string command = argv[1];
  if (command == "bench") {
    benchmark(argv[2], argc > 3 ? std::stoi(argv[3]) : 1, argc > 4 ? std::stoi(argv[4]) : 1000);
  } else if (command == "bench-wav" && (argc == 4 || argc == 5)) {
    const Wav wav = readWav16(argv[3]);
    benchmark(argv[2], 1, argc > 4 ? std::stoi(argv[4]) : 1000, &wav);
  } else if (command == "separate" && argc == 5) {
    separate(argv[2], argv[3], argv[4]);
  } else {
    usage();
  }
}
