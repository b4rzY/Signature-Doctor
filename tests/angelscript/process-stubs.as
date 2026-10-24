// Synthetic memory and the common documented Process API. No operating-system access.
uint64 fixture_base = uint64(0xfedcba9876540000);
uint fixture_module_size = 65536;
string fixture_executable = "Fixture.exe";
uint fixture_pid = 42;
array<uint8> fixture_memory(131072);
bool fixture_running = true;
bool fixture_attached = true;
bool fixture_reads_succeed = true;
bool fixture_short_reads = false;
bool fixture_relative_wrong = false;
uint fixture_scan_count = 1;
uint64 fixture_scan_rva = 0x100;

void fixture_reset(string name = "Fixture.exe") {
    fixture_base = uint64(0xfedcba9876540000);
    fixture_module_size = 65536; fixture_executable = name; fixture_pid = 42;
    fixture_running = true; fixture_attached = true; fixture_reads_succeed = true;
    fixture_short_reads = false; fixture_relative_wrong = false; fixture_scan_count = 1; fixture_scan_rva = 0x100;
    for (uint i = 0; i < fixture_memory.length(); i++) fixture_memory[i] = 0;
}
void fixture_write(uint64 address, uint64 value, uint size) {
    for (uint i = 0; i < size; i++) fixture_memory[uint(address - fixture_base) + i] = uint8(value >> (8 * i));
}
bool fixture_read(uint64 address, uint size, uint64 &out value) {
    value = 0;
    if (!fixture_running || !fixture_attached || !fixture_reads_succeed || size == 0 || address < fixture_base || address - fixture_base > fixture_memory.length() || size > fixture_memory.length() - uint(address - fixture_base)) return false;
    for (uint i = 0; i < size; i++) value |= uint64(fixture_memory[uint(address - fixture_base) + i]) << (8 * i);
    return true;
}
attach_data fixture_attach(string name) {
    attach_data result;
    if (fixture_running && name == fixture_executable) {
        fixture_attached = true; result.pid = fixture_pid; result.peb_address = fixture_base + 0x800; result.base_address = fixture_base;
    } else fixture_attached = false;
    return result;
}
class module_entry { string name; uint64 base; uint64 size; }
class memory_buffer {
    uint64 begin_; uint64 length_;
    uint64 size() { return length_; }
    uint8 read_uint8(uint64 offset) { return offset < length_ ? fixture_memory[uint(begin_ - fixture_base + offset)] : uint8(0); }
}
namespace process {
    bool is_alive() { return fixture_running && fixture_attached; }
    void detach() { fixture_attached = false; }
    uint64 get_module_base(string name) { return is_alive() && name == fixture_executable ? fixture_base : uint64(0); }
    uint32 get_module_size(uint64 base) { return is_alive() && base == fixture_base ? fixture_module_size : uint(0); }
    array<module_entry>@ get_module_list() {
        array<module_entry>@ modules = array<module_entry>();
        if (is_alive()) { module_entry module; module.name = fixture_executable; module.base = fixture_base; module.size = fixture_module_size; modules.insertLast(module); }
        return modules;
    }
    array<uint64>@ find_signatures(uint64 base, string sig) {
        array<uint64>@ hits = array<uint64>();
        if (is_alive() && base == fixture_base) for (uint i = 0; i < fixture_scan_count; i++) hits.insertLast(base + fixture_scan_rva + i * 0x10);
        return hits;
    }
    array<uint8>@ read_bytes(uint64 address, uint32 size) {
        uint64 first;
        if (!fixture_read(address, 1, first) || address - fixture_base > fixture_memory.length() || size > fixture_memory.length() - uint(address - fixture_base)) return null;
        uint length = fixture_short_reads && size > 0 ? size - 1 : size;
        array<uint8>@ bytes = array<uint8>(length);
        for (uint i = 0; i < length; i++) bytes[i] = fixture_memory[uint(address - fixture_base) + i];
        return bytes;
    }
    memory_buffer@ read_buffer(uint64 address, uint64 size) {
        uint64 first;
        if (size == 0 || !fixture_read(address, 1, first) || size > fixture_memory.length() - uint(address - fixture_base)) return null;
        memory_buffer@ buffer = memory_buffer(); buffer.begin_ = address; buffer.length_ = fixture_short_reads ? size - 1 : size;
        return buffer;
    }
    bool read_uint8(uint64 address, uint8 &out result) { uint64 value; bool ok = fixture_read(address, 1, value); result = uint8(value); return ok; }
    bool read_int8(uint64 address, int8 &out result) { uint64 value; bool ok = fixture_read(address, 1, value); result = int8(value); return ok; }
    bool read_uint16(uint64 address, uint16 &out result) { uint64 value; bool ok = fixture_read(address, 2, value); result = uint16(value); return ok; }
    bool read_int16(uint64 address, int16 &out result) { uint64 value; bool ok = fixture_read(address, 2, value); result = int16(value); return ok; }
    bool read_uint32(uint64 address, uint32 &out result) { uint64 value; bool ok = fixture_read(address, 4, value); result = uint32(value); return ok; }
    bool read_int32(uint64 address, int32 &out result) { uint64 value; bool ok = fixture_read(address, 4, value); result = int32(value); return ok; }
    bool read_uint64(uint64 address, uint64 &out result) { return fixture_read(address, 8, result); }
    bool read_int64(uint64 address, int64 &out result) { uint64 value; bool ok = fixture_read(address, 8, value); result = int64(value); return ok; }
    bool read_float(uint64 address, float &out result) { uint64 value; bool ok = fixture_read(address, 4, value); result = fixture_float(uint(value)); return ok; }
    bool read_double(uint64 address, double &out result) { uint64 value; bool ok = fixture_read(address, 8, value); result = fixture_double(value); return ok; }
    uint64 get_relative_address(uint64 address, uint32 offset, uint32 inst_size) {
        int32 displacement;
        if (!read_int32(address + offset, displacement)) return 0;
        uint64 next = address + inst_size;
        uint64 target = displacement < 0 ? next - uint64(-int64(displacement)) : next + uint64(displacement);
        return fixture_relative_wrong ? target + 1 : target;
    }
}
