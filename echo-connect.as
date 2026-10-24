// Signature Doctor — Echo / Angel connector
// 1. Start Signature Doctor with npm start (or run.bat).
// 2. Set PROCESS_NAME below to the process in your catalog.
// 3. Load this file in Echo. This uses the current documented one-argument attach API.
//
// If web-mv already owns process::open_socket, use WEB_MV_URL proxy mode instead.
// Do not load this connector alongside another owner of the built-in process socket.

const string PROCESS_NAME = "YourApplication.exe";
const string RELAY_URL = "ws://127.0.0.1:3210/agent";
bool attached_by_doctor = false;

void connect_doctor()
{
    if (!attached_by_doctor || !process::is_alive())
    {
        attach_data target = process::attach(PROCESS_NAME);
        if (target.pid == 0)
        {
            attached_by_doctor = false;
            print("[Signature Doctor] Attach failed. Check PROCESS_NAME and launch the application.");
            return;
        }
        attached_by_doctor = true;
    }
    if (process::open_socket(RELAY_URL))
        print("[Signature Doctor] Connected. Open http://127.0.0.1:3210 and select Live.");
    else
        print("[Signature Doctor] Connection failed. Start the server or close the existing process socket.");
}

void disconnect_doctor()
{
    if (attached_by_doctor) process::detach();
    attached_by_doctor = false;
}

bool main()
{
    ui::add_tab("Signature Doctor");
    ui::add_category("Connection");
    ui::add_button("Connect", @connect_doctor);
    ui::add_button("Disconnect", @disconnect_doctor);
    connect_doctor();
    return true;
}

void on_unload()
{
    disconnect_doctor();
}
