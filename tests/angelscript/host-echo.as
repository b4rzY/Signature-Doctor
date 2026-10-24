// API-shaped fixture only: documented Echo attach_data and attach signature.
class attach_data { uint64 pid; uint64 peb_address; uint64 base_address; }
namespace process {
    attach_data attach(string name) { return fixture_attach(name); }
}
