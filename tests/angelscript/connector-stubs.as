// API-shaped JSON, mutex, UI and WebSocket fixtures. Dispatch is exercised directly;
// parsing, serialization, native threads and network transport are not simulated.
enum json_type { null_value, boolean, number, string, object, array }
class json_cell {
    string key; json_type kind = json_type::null_value;
    string text; double numeric = 0; bool flag = false; json_obj@ nested;
}
class json_obj {
    bool array_mode = false;
    array<json_cell@> cells;
    json_cell@ find(string key) {
        for (uint i = 0; i < cells.length(); i++) if (cells[i].key == key) return cells[i];
        return null;
    }
    json_cell@ slot(string key) {
        json_cell@ cell = find(key);
        if (cell is null) { @cell = json_cell(); cell.key = key; cells.insertLast(cell); }
        return cell;
    }
    bool has(string key) { return find(key) !is null; }
    uint length() { return cells.length(); }
    json_type type(string key) { json_cell@ cell = find(key); return cell is null ? json_type::null_value : cell.kind; }
    array<string>@ keys() { array<string>@ result = array<string>(); for (uint i = 0; i < cells.length(); i++) result.insertLast(cells[i].key); return result; }
    string get_string(string key) { json_cell@ c = find(key); return c !is null && c.kind == json_type::string ? c.text : ""; }
    double get_double(string key) { json_cell@ c = find(key); return c !is null && c.kind == json_type::number ? c.numeric : 0; }
    bool get_bool(string key) { json_cell@ c = find(key); return c !is null && c.kind == json_type::boolean ? c.flag : false; }
    json_obj@ get_obj(string key) { json_cell@ c = find(key); return c !is null ? c.nested : null; }
    json_obj@ get_obj_at(uint index) { return index < cells.length() ? cells[index].nested : null; }
    string get_string_at(uint index) { return index < cells.length() ? cells[index].text : ""; }
    void set(string key, string value) { json_cell@ c = slot(key); c.kind = json_type::string; c.text = value; }
    void set(string key, bool value) { json_cell@ c = slot(key); c.kind = json_type::boolean; c.flag = value; }
    void set(string key, double value) { json_cell@ c = slot(key); c.kind = json_type::number; c.numeric = value; }
    void set(string key, float value) { set(key, double(value)); }
    void set(string key, int value) { set(key, double(value)); }
    void set(string key, uint value) { set(key, double(value)); }
    void set(string key, int64 value) { set(key, double(value)); }
    void set(string key, uint64 value) { set(key, double(value)); }
    void set(string key, json_obj@ value) { json_cell@ c = slot(key); c.kind = value !is null && value.array_mode ? json_type::array : json_type::object; @c.nested = value; }
    void push(string value) { json_cell@ c = json_cell(); c.kind = json_type::string; c.text = value; cells.insertLast(c); }
    void push(json_obj@ value) { json_cell@ c = json_cell(); c.kind = value !is null && value.array_mode ? json_type::array : json_type::object; @c.nested = value; cells.insertLast(c); }
}
namespace json {
    json_obj@ array() { json_obj@ result = json_obj(); result.array_mode = true; return result; }
    json_obj@ parse(string text, string &out error) { error = "Parser not simulated by fixture"; return null; }
    string stringify(json_obj@ obj, bool beautify = false) { return "{}"; }
}
class mutex { void lock() {} void unlock() {} }
mutex@ create_mutex() { return mutex(); }
funcdef void connect_callback();
funcdef void message_callback(string);
funcdef void disconnect_callback();
funcdef void error_callback(string);
funcdef void button_callback();
bool fixture_ws_connected = false;
disconnect_callback@ fixture_disconnect;
namespace ws {
    bool is_connected() { return fixture_ws_connected; }
    void connect(string url, connect_callback@ open, message_callback@ message, disconnect_callback@ close, error_callback@ error) {
        fixture_ws_connected = true; @fixture_disconnect = close;
        if (open !is null) open();
    }
    void disconnect() { fixture_ws_connected = false; if (fixture_disconnect !is null) fixture_disconnect(); }
    void send(string message) {}
}
class button {}
namespace ui {
    void add_tab(string label) {}
    void add_category(string label) {}
    button add_button(string label, button_callback@ callback) { return button(); }
}
