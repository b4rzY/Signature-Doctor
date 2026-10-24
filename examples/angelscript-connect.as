// Signature Doctor — portable AngelScript connector
// Uses shared process / JSON / WebSocket host bindings; see docs/COMPATIBILITY.md.
// 1. Start Signature Doctor, then set PROCESS_NAME to your catalog's executable.
// 2. Load this file through your AngelScript host and select Live in the dashboard.
// 3. After a lost connection, use Connect again. Disconnect never auto-reconnects.
// This script is read-only. It does not require a native process socket API.
// Native scans cannot be interrupted by script code; the server bounds caller wait time.

const string PROCESS_NAME = "YourApplication.exe";
const string RELAY_URL = "ws://127.0.0.1:3210/agent";
const uint64 SD_U64_MAX = uint64(0xffffffffffffffff);
mutex@ sd_mutex = create_mutex();
bool sd_wanted = false;
bool sd_closing = false;
bool sd_attached = false;
bool sd_owned_attachment = false;
uint64 sd_pid = 0;
uint64 sd_base = 0;

string sd_hex(uint64 value)
{
    const string digits = "0123456789abcdef";
    if (value == 0) return "0x0";
    string result;
    while (value != 0)
    {
        result = digits.substr(uint(value & 15), 1) + result;
        value >>= 4;
    }
    return "0x" + result;
}

int sd_digit(uint8 c)
{
    if (c >= 48 && c <= 57) return int(c - 48);
    if (c >= 65 && c <= 70) return int(c - 65) + 10;
    if (c >= 97 && c <= 102) return int(c - 97) + 10;
    return -1;
}

bool sd_address(const string &in text, uint64 &out value)
{
    value = 0;
    if (text.length() == 0 || text.length() > 20) return false;
    uint start = 0;
    uint radix = 10;
    if (text.length() >= 2 && text[0] == 48 && (text[1] == 120 || text[1] == 88))
    {
        start = 2; radix = 16;
        if (text.length() > 18) return false;
    }
    if (start == text.length()) return false;
    for (uint i = start; i < text.length(); i++)
    {
        int digit = sd_digit(text[i]);
        if (digit < 0 || uint(digit) >= radix) return false;
        if (value > (SD_U64_MAX - uint64(digit)) / radix) return false;
        value = value * radix + uint64(digit);
    }
    return value != 0;
}

bool sd_uint(json_obj@ object, const string &in key, uint minimum, uint maximum, uint &out value)
{
    value = 0;
    if (object is null || object.type(key) != json_type::number) return false;
    double raw = object.get_double(key);
    if (!(raw >= double(minimum) && raw <= double(maximum))) return false;
    value = uint(raw);
    return double(value) == raw;
}

bool sd_keys(json_obj@ object, const array<string> &in allowed)
{
    array<string>@ keys = object.keys();
    if (keys is null) return false;
    for (uint i = 0; i < keys.length(); i++)
    {
        bool found = false;
        for (uint j = 0; j < allowed.length(); j++) if (keys[i] == allowed[j]) found = true;
        if (!found) return false;
    }
    return true;
}

json_obj@ sd_reply(const string &in type, uint id)
{
    json_obj@ reply = json_obj();
    reply.set("type", type); reply.set("id", id);
    return reply;
}

json_obj@ sd_error(uint id, int code, const string &in message)
{
    json_obj@ reply = sd_reply("error", id);
    reply.set("code", code); reply.set("message", message);
    return reply;
}

bool sd_refresh_target()
{
    // Refresh the actual PID on every ping; never report a cached PID after a restart.
    attach_data target = process::attach(PROCESS_NAME);
    sd_pid = uint64(target.pid); sd_base = target.base_address;
    sd_attached = sd_pid != 0 && sd_pid <= uint64(0xffffffff) && sd_base != 0 && target.peb_address != 0 && process::is_alive();
    if (sd_attached) sd_owned_attachment = true;
    if (!sd_attached) { sd_pid = 0; sd_base = 0; }
    return sd_attached;
}

bool sd_module_name(const string &in name)
{
    if (name.length() == 0 || name.length() > 260) return false;
    for (uint i = 0; i < name.length(); i++) if (name[i] < 32 || name[i] == 127) return false;
    return true;
}

bool sd_read_arguments(json_obj@ request, uint64 &out address, uint &out size)
{
    return request.type("address") == json_type::string && sd_address(request.get_string("address"), address)
        && sd_uint(request, "size", 1, 65536, size) && address <= SD_U64_MAX - uint64(size - 1);
}

json_obj@ sd_read(uint64 address, uint size)
{
    json_obj@ result = json_obj();
    result.set("address", sd_hex(address));
    memory_buffer@ buffer = process::read_buffer(address, uint64(size));
    bool success = buffer !is null;
    if (success) success = buffer.size() == uint64(size);
    string bytes;
    if (success)
    {
        const string digits = "0123456789abcdef";
        for (uint i = 0; i < size; i++)
        {
            uint8 byte = buffer.read_uint8(uint64(i));
            bytes += digits.substr(uint(byte >> 4), 1) + digits.substr(uint(byte & 15), 1);
        }
    }
    result.set("success", success);
    result.set("size", success ? size : uint(0));
    result.set("data", bytes);
    return result;
}

bool sd_space(uint8 c) { return c == 32 || c == 9 || c == 10 || c == 13; }
bool sd_pattern(const string &in pattern)
{
    if (pattern.length() == 0 || pattern.length() > 1024) return false;
    uint i = 0, count = 0;
    bool concrete = false;
    while (i < pattern.length())
    {
        while (i < pattern.length() && sd_space(pattern[i])) i++;
        if (i == pattern.length()) break;
        uint start = i;
        while (i < pattern.length() && !sd_space(pattern[i])) i++;
        uint size = i - start;
        if (size == 1 && pattern[start] == 63) {}
        else if (size == 2 && pattern[start] == 63 && pattern[start + 1] == 63) {}
        else if (size == 2 && sd_digit(pattern[start]) >= 0 && sd_digit(pattern[start + 1]) >= 0) concrete = true;
        else return false;
        count++;
        if (count > 256) return false;
    }
    return count != 0 && concrete;
}

json_obj@ sd_handle_request(json_obj@ request)
{
    uint id = 0;
    if (request is null) return sd_error(id, 1002, "Expected a JSON object.");
    if (request.has("id") && !sd_uint(request, "id", 0, 2147483647, id)) return sd_error(0, 1002, "Invalid request ID.");
    if (request.type("type") != json_type::string) return sd_error(id, 1002, "Missing request type.");
    string type = request.get_string("type");

    if (type == "ping")
    {
        if (!sd_keys(request, {"type", "id"})) return sd_error(id, 1002, "Unsupported ping property.");
        json_obj@ reply = sd_reply("ping_result", id);
        bool attached = sd_refresh_target();
        reply.set("attached", attached);
        if (attached) { reply.set("pid", sd_pid); reply.set("base", sd_hex(sd_base)); }
        reply.set("protocol", "signature-doctor/1");
        reply.set("connector", "portable-angelscript");
        json_obj@ capabilities = json::array();
        array<string> verbs = {"ping", "modules", "read", "read_batch", "sig_scan_ida", "resolve_relative"};
        for (uint i = 0; i < verbs.length(); i++) capabilities.push(verbs[i]);
        reply.set("capabilities", capabilities);
        return reply;
    }
    if (!sd_attached || !process::is_alive()) return sd_error(id, 1001, "The configured target is not attached or has exited. Run a new check or reconnect.");

    if (type == "modules")
    {
        if (!sd_keys(request, {"type", "id"})) return sd_error(id, 1002, "Unsupported modules property.");
        array<module_entry>@ loaded = process::get_module_list();
        if (loaded is null || loaded.length() == 0) return sd_error(id, 1003, "The runtime could not enumerate target modules. Check its process/module support.");
        if (loaded.length() > 4096) return sd_error(id, 1004, "Too many modules to return safely.");
        json_obj@ modules = json::array();
        for (uint i = 0; i < loaded.length(); i++)
        {
            module_entry module = loaded[i];
            if (!sd_module_name(module.name) || module.base == 0 || module.size == 0 || module.size > uint64(9007199254740991)
                || module.base > SD_U64_MAX - (module.size - 1)) return sd_error(id, 1003, "The runtime returned incomplete or invalid module metadata.");
            json_obj@ entry = json_obj();
            entry.set("name", module.name); entry.set("base", sd_hex(module.base)); entry.set("size", module.size);
            modules.push(entry);
        }
        json_obj@ reply = sd_reply("modules_result", id);
        reply.set("success", true); reply.set("modules", modules);
        return reply;
    }
    if (type == "read")
    {
        uint64 address = 0; uint size = 0;
        if (!sd_keys(request, {"type", "id", "address", "size"}) || !sd_read_arguments(request, address, size)) return sd_error(id, 1002, "Invalid or overflowing read range.");
        json_obj@ reply = sd_read(address, size);
        reply.set("type", "read_result"); reply.set("id", id);
        return reply;
    }
    if (type == "read_batch")
    {
        if (!sd_keys(request, {"type", "id", "reads"}) || request.type("reads") != json_type::array) return sd_error(id, 1002, "Expected a bounded reads array.");
        json_obj@ reads = request.get_obj("reads");
        if (reads is null || reads.length() == 0 || reads.length() > 64) return sd_error(id, 1004, "A batch requires 1–64 reads.");
        array<uint64> addresses; array<uint> sizes;
        uint total = 0;
        for (uint i = 0; i < reads.length(); i++)
        {
            json_obj@ read = reads.get_obj_at(i);
            uint64 address = 0; uint size = 0;
            if (read is null || !sd_keys(read, {"address", "size"}) || !sd_read_arguments(read, address, size)) return sd_error(id, 1002, "Invalid batch read.");
            total += size;
            if (total > 262144) return sd_error(id, 1004, "A batch is limited to 256 KiB.");
            addresses.insertLast(address); sizes.insertLast(size);
        }
        json_obj@ results = json::array();
        for (uint i = 0; i < addresses.length(); i++) results.push(sd_read(addresses[i], sizes[i]));
        json_obj@ reply = sd_reply("read_batch_result", id);
        reply.set("success", true); reply.set("results", results);
        return reply;
    }
    if (type == "sig_scan_ida")
    {
        if (!sd_keys(request, {"type", "id", "module", "pattern", "find_all"}) || request.type("module") != json_type::string
            || request.type("pattern") != json_type::string || request.type("find_all") != json_type::boolean || !request.get_bool("find_all")) return sd_error(id, 1002, "Scans require a module, IDA pattern and find_all: true.");
        string name = request.get_string("module"), pattern = request.get_string("pattern");
        if (!sd_module_name(name) || !sd_pattern(pattern)) return sd_error(id, 1002, "Invalid module or pattern; use 1–256 bytes and at least one concrete byte.");
        uint64 base = process::get_module_base(name);
        uint64 size = process::get_module_size(base);
        if (base == 0 || size == 0) return sd_error(id, 1003, "Module not found or its size is unavailable; the scan was not run.");
        array<uint64>@ hits = process::find_signatures(base, pattern);
        if (hits is null) return sd_error(id, 1005, "The runtime's signature scan failed.");
        if (hits.length() > 4096) return sd_error(id, 1004, "More than 4096 signature matches; narrow the pattern. No partial candidate list was accepted.");
        json_obj@ results = json::array();
        for (uint i = 0; i < hits.length(); i++)
        {
            if (hits[i] < base || hits[i] - base >= size) return sd_error(id, 1005, "A scan result was outside the requested module.");
            results.push(sd_hex(hits[i]));
        }
        json_obj@ reply = sd_reply("sig_scan_ida_result", id);
        reply.set("success", hits.length() != 0); reply.set("results", results);
        reply.set("module", name); reply.set("pattern", pattern);
        return reply;
    }
    if (type == "resolve_relative")
    {
        uint64 address = 0; uint offset = 0, instruction_size = 0;
        if (!sd_keys(request, {"type", "id", "address", "offset", "inst_size"}) || request.type("address") != json_type::string
            || !sd_address(request.get_string("address"), address) || !sd_uint(request, "offset", 0, 60, offset)
            || !sd_uint(request, "inst_size", 4, 64, instruction_size) || offset + 4 > instruction_size
            || address > SD_U64_MAX - uint64(instruction_size)) return sd_error(id, 1002, "Invalid or overflowing relative-reference range.");
        int32 displacement = 0;
        if (!process::read_int32(address + uint64(offset), displacement)) return sd_error(id, 1005, "Could not read the signed relative displacement.");
        uint64 next = address + uint64(instruction_size);
        uint64 magnitude = displacement < 0 ? uint64(-int64(displacement)) : uint64(displacement);
        uint64 target = 0;
        if (displacement < 0)
        {
            if (next < magnitude) return sd_error(id, 1002, "Relative reference underflow.");
            target = next - magnitude;
        }
        else
        {
            if (next > SD_U64_MAX - magnitude) return sd_error(id, 1002, "Relative reference overflow.");
            target = next + magnitude;
        }
        if (target == 0) return sd_error(id, 1005, "Relative target is null.");
        json_obj@ reply = sd_reply("resolve_relative_result", id);
        reply.set("success", true); reply.set("address", sd_hex(target));
        return reply;
    }
    return sd_error(id, 1000, "Unsupported command. This connector only serves read-only Signature Doctor requests.");
}

void sd_on_message(string message)
{
    string error;
    json_obj@ request;
    if (message.length() <= 32768) @request = json::parse(message, error);
    json_obj@ reply;
    sd_mutex.lock();
    if (!sd_wanted) @reply = sd_error(0, 1001, "Connector is disconnected.");
    else @reply = sd_handle_request(request);
    sd_mutex.unlock();
    if (ws::is_connected()) ws::send(json::stringify(reply));
}

void sd_on_open()
{
    sd_mutex.lock();
    bool wanted = sd_wanted;
    sd_mutex.unlock();
    if (!wanted) { ws::disconnect(); return; }
    print("[Signature Doctor] Connected. Open the dashboard and select Live.");
}

void sd_on_disconnect()
{
    sd_mutex.lock();
    sd_wanted = false; sd_closing = false;
    if (sd_owned_attachment) process::detach();
    sd_attached = false; sd_owned_attachment = false; sd_pid = 0; sd_base = 0;
    sd_mutex.unlock();
    print("[Signature Doctor] Disconnected. Use Connect when ready; no automatic reconnect is scheduled.");
}

void sd_on_error(string message)
{
    sd_mutex.lock(); sd_wanted = false; sd_mutex.unlock();
    print("[Signature Doctor] Connection error: " + message + ". Disconnect and wait for the Disconnected message before reconnecting. Reload this script if the host does not complete teardown.");
}

void connect_doctor()
{
    if (ws::is_connected()) { print("[Signature Doctor] Already connected. Disconnect before switching targets."); return; }
    sd_mutex.lock();
    if (sd_closing) { sd_mutex.unlock(); print("[Signature Doctor] Waiting for disconnect to complete. Reload this script if the host does not complete teardown."); return; }
    if (sd_wanted) { sd_mutex.unlock(); print("[Signature Doctor] A connection is already pending."); return; }
    if (!sd_refresh_target()) { sd_mutex.unlock(); print("[Signature Doctor] Attach failed. Check PROCESS_NAME and start the target."); return; }
    sd_wanted = true;
    sd_mutex.unlock();
    ws::connect(RELAY_URL, @sd_on_open, @sd_on_message, @sd_on_disconnect, @sd_on_error);
}

void disconnect_doctor()
{
    bool connected = ws::is_connected();
    sd_mutex.lock();
    sd_closing = sd_closing || connected || sd_wanted;
    sd_wanted = false;
    if (sd_owned_attachment) process::detach();
    sd_attached = false; sd_owned_attachment = false; sd_pid = 0; sd_base = 0;
    sd_mutex.unlock();
    ws::disconnect();
}

bool main()
{
    ui::add_tab("Signature Doctor");
    ui::add_category("Runtime connection");
    ui::add_button("Connect", @connect_doctor);
    ui::add_button("Disconnect", @disconnect_doctor);
    connect_doctor();
    return true;
}

void on_unload() { disconnect_doctor(); }
