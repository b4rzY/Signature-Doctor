json_obj@ fixture_request(string type, uint id = 7) { json_obj@ request = json_obj(); request.set("type", type); request.set("id", id); return request; }
bool fixture_code(json_obj@ response, int code) { return response.get_string("type") == "error" && response.get_double("code") == double(code); }
bool test_main() {
    fixture_reset(PROCESS_NAME);
    if (!main() || !sd_attached || !ws::is_connected()) return false;
    uint64 address = 0;
    if (!sd_address("18446744073709551615", address) || address != uint64(0xffffffffffffffff)) return false;
    if (sd_address("18446744073709551616", address) || sd_address("0x10000000000000000", address) || sd_address("0", address)) return false;
    if (sd_hex(uint64(0xfedcba9876543210)) != "0xfedcba9876543210") return false;
    json_obj@ response = sd_handle_request(fixture_request("ping"));
    if (!response.get_bool("attached") || response.get_double("pid") != 42 || response.get_string("base") != sd_hex(fixture_base)) return false;
    fixture_pid = 43;
    @response = sd_handle_request(fixture_request("ping"));
    if (response.get_double("pid") != 43) return false;
    @response = sd_handle_request(fixture_request("modules"));
    if (!response.get_bool("success") || response.get_obj("modules").length() != 1 || response.get_obj("modules").get_obj_at(0).get_string("base") != sd_hex(fixture_base)) return false;

    json_obj@ request = fixture_request("read"); request.set("address", sd_hex(fixture_base + 0x400)); request.set("size", 4);
    @response = sd_handle_request(request);
    if (!response.get_bool("success") || response.get_string("data") != "00000000" || response.get_double("size") != 4) return false;
    fixture_reads_succeed = false; @response = sd_handle_request(request);
    if (response.get_bool("success") || response.get_string("data") != "" || response.get_double("size") != 0) return false;
    fixture_reads_succeed = true; fixture_short_reads = true; @response = sd_handle_request(request);
    if (response.get_bool("success")) return false; fixture_short_reads = false;
    request.set("address", "0xffffffffffffffff"); request.set("size", 2);
    if (!fixture_code(sd_handle_request(request), 1002)) return false;
    request.set("address", double(1024));
    if (!fixture_code(sd_handle_request(request), 1002)) return false;

    @request = fixture_request("read_batch"); json_obj@ reads = json::array();
    json_obj@ good = json_obj(); good.set("address", sd_hex(fixture_base + 0x400)); good.set("size", 4); reads.push(good);
    json_obj@ bad = json_obj(); bad.set("address", sd_hex(fixture_base + 0x30000)); bad.set("size", 4); reads.push(bad); request.set("reads", reads);
    @response = sd_handle_request(request);
    if (!response.get_bool("success") || !response.get_obj("results").get_obj_at(0).get_bool("success") || response.get_obj("results").get_obj_at(1).get_bool("success")) return false;

    @request = fixture_request("sig_scan_ida"); request.set("module", PROCESS_NAME); request.set("pattern", "48 8B ??"); request.set("find_all", true);
    fixture_scan_count = 2; @response = sd_handle_request(request);
    if (!response.get_bool("success") || response.get_obj("results").length() != 2) return false;
    request.set("find_all", false); if (!fixture_code(sd_handle_request(request), 1002)) return false;
    request.set("find_all", true); request.set("pattern", "?? ??"); if (!fixture_code(sd_handle_request(request), 1002)) return false;
    request.set("pattern", "48 8B ??"); fixture_scan_count = 4097; if (!fixture_code(sd_handle_request(request), 1004)) return false;
    fixture_scan_count = 0; @response = sd_handle_request(request);
    if (response.get_bool("success") || response.get_obj("results").length() != 0) return false;

    fixture_write(fixture_base + 0x103, uint64(0xffffff79), 4);
    @request = fixture_request("resolve_relative"); request.set("address", sd_hex(fixture_base + 0x100)); request.set("offset", 3); request.set("inst_size", 7);
    @response = sd_handle_request(request);
    if (!response.get_bool("success") || response.get_string("address") != sd_hex(fixture_base + 0x80)) return false;
    if (!fixture_code(sd_handle_request(fixture_request("write")), 1000)) return false;
    fixture_running = false; @response = sd_handle_request(fixture_request("ping"));
    if (response.get_bool("attached") || response.has("pid") || response.has("base")) return false;
    disconnect_doctor();
    return !ws::is_connected() && !sd_attached && !sd_wanted;
}
