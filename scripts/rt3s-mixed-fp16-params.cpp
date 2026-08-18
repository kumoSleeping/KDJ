// Converts only RT3S feed-forward matrix/bias tensors to IEEE binary16.
// LSTM and RMSNorm tensors stay float32, so recurrent state and normalization remain full precision.

#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr std::array<uint32_t, 11> kFp16TensorIndices = {
    0, 1,       // spectrogram encoder matrix + bias
    3, 4,       // spectrogram mask matrix + bias
    5, 6,       // waveform convolution encoder matrix + bias
    7, 8,       // waveform basis projection matrix + bias
    10, 11,     // waveform mask matrix + bias
    12,         // waveform transposed convolution matrix
};

bool convertTensor(uint32_t index) {
    for (const auto candidate : kFp16TensorIndices) {
        if (candidate == index) return true;
    }
    return false;
}

uint16_t floatToHalf(float value) {
    const uint32_t bits = std::bit_cast<uint32_t>(value);
    const uint32_t sign = (bits >> 16) & 0x8000u;
    const uint32_t exponent = (bits >> 23) & 0xffu;
    const uint32_t mantissa = bits & 0x7fffffu;
    if (exponent == 0xffu) {
        return static_cast<uint16_t>(sign | (mantissa == 0 ? 0x7c00u : 0x7e00u));
    }
    const int32_t half_exponent = static_cast<int32_t>(exponent) - 127 + 15;
    if (half_exponent >= 31) return static_cast<uint16_t>(sign | 0x7c00u);
    if (half_exponent <= 0) {
        if (half_exponent < -10) return static_cast<uint16_t>(sign);
        const uint32_t normalized = mantissa | 0x800000u;
        const uint32_t shift = static_cast<uint32_t>(14 - half_exponent);
        uint32_t rounded = normalized >> shift;
        const uint32_t remainder = normalized & ((1u << shift) - 1u);
        const uint32_t halfway = 1u << (shift - 1u);
        if (remainder > halfway || (remainder == halfway && (rounded & 1u))) ++rounded;
        return static_cast<uint16_t>(sign | rounded);
    }
    uint32_t rounded_mantissa = mantissa >> 13;
    const uint32_t remainder = mantissa & 0x1fffu;
    if (remainder > 0x1000u || (remainder == 0x1000u && (rounded_mantissa & 1u))) {
        ++rounded_mantissa;
        if (rounded_mantissa == 0x400u) {
            rounded_mantissa = 0;
            if (half_exponent + 1 >= 31) return static_cast<uint16_t>(sign | 0x7c00u);
            return static_cast<uint16_t>(sign | ((half_exponent + 1) << 10));
        }
    }
    return static_cast<uint16_t>(sign | (static_cast<uint32_t>(half_exponent) << 10) |
        rounded_mantissa);
}

uint64_t readLength(std::ifstream& input) {
    uint64_t bytes {};
    input.read(reinterpret_cast<char*>(&bytes), sizeof(bytes));
    return bytes;
}

void writeLength(std::ofstream& output, uint64_t bytes) {
    output.write(reinterpret_cast<const char*>(&bytes), sizeof(bytes));
}

int run(const std::string& source, const std::string& destination) {
    std::ifstream input(source, std::ios::binary);
    std::ofstream output(destination, std::ios::binary | std::ios::trunc);
    if (!input || !output) throw std::runtime_error("cannot open input or output file");
    uint32_t index = 0;
    uint64_t input_bytes = 0;
    uint64_t output_bytes = 0;
    while (input.peek() != std::ifstream::traits_type::eof()) {
        const uint64_t bytes = readLength(input);
        if (!input || bytes == 0 || bytes % sizeof(float) != 0) {
            throw std::runtime_error("invalid params tensor at index " + std::to_string(index));
        }
        std::vector<float> tensor(bytes / sizeof(float));
        input.read(reinterpret_cast<char*>(tensor.data()), static_cast<std::streamsize>(bytes));
        if (!input) throw std::runtime_error("truncated params tensor");
        input_bytes += sizeof(bytes) + bytes;
        if (convertTensor(index)) {
            std::vector<uint16_t> half(tensor.size());
            for (size_t element = 0; element < tensor.size(); ++element) {
                half[element] = floatToHalf(tensor[element]);
            }
            const uint64_t converted_bytes = half.size() * sizeof(uint16_t);
            writeLength(output, converted_bytes);
            output.write(reinterpret_cast<const char*>(half.data()),
                static_cast<std::streamsize>(converted_bytes));
            output_bytes += sizeof(converted_bytes) + converted_bytes;
        }
        else {
            writeLength(output, bytes);
            output.write(reinterpret_cast<const char*>(tensor.data()),
                static_cast<std::streamsize>(bytes));
            output_bytes += sizeof(bytes) + bytes;
        }
        ++index;
    }
    if (index != 53) throw std::runtime_error("expected 53 tensors, found " + std::to_string(index));
    std::cout << "{\"tensors\":" << index << ",\"converted_tensors\":"
              << kFp16TensorIndices.size() << ",\"input_bytes\":" << input_bytes
              << ",\"output_bytes\":" << output_bytes << "}\n";
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "usage: rt3s-mixed-fp16-params INPUT_PARAMS OUTPUT_PARAMS\n";
        return 2;
    }
    try {
        return run(argv[1], argv[2]);
    }
    catch (const std::exception& error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
