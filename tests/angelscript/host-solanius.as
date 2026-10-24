// API-shaped fixture only: user-supplied Solanius attach_data and attach signature.
class attach_data { uint32 pid; uint64 peb_address; uint64 base_address; }
namespace process {
    attach_data attach(string name, bool attach_window = true) { return fixture_attach(name); }
}
