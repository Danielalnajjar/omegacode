import fs from "node:fs"

// The CLI fixture tests native persistent launch even when run on a thread VM.
const existsSync = fs.existsSync
fs.existsSync = (path) => path !== "/etc/thread-vm/base-verified" && existsSync(path)
