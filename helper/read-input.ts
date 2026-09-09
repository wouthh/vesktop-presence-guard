// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from "gi://Gio";
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";

// Linux open flags, verified on the supported GNOME desktop. Never open a FIFO
// in blocking mode or follow a replaced final symlink between stat and read.
const flags = 0x800 | 0x20000 | 0x80000; // O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
export function readHelperInput(path: string) {
    const fd = GLib.open(path, flags, 0);
    if (fd < 0) throw Error("helper_input_open_failed");
    const stream = new GioUnix.InputStream({ fd, close_fd: true });
    try {
        // /proc anchors metadata to the already-open descriptor, including proc
        // stat files whose advertised size is zero. Never reopen the input path.
        const info = Gio.File.new_for_path(`/proc/self/fd/${fd}`).query_info("standard::type,standard::size", Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 65536) throw Error("unsafe_helper_input");
        const bytes = stream.read_bytes(65537, null).get_data();
        if (!bytes || bytes.length > 65536) throw Error("bounded_read_failed");
        return new TextDecoder().decode(bytes);
    } finally { stream.close(null); }
}
