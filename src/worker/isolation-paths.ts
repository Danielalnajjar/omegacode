import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

export const SYSTEM_ROOTS = ["/bin", "/usr/bin", "/usr/lib", "/System/Library", "/private/etc", "/dev"]
export const inside = (path: string, root: string) => path === root || (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)))

export function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(path)
    if (parent === path) throw error
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return canonical(resolve(canonical(parent), readlinkSync(path)))
    return join(canonical(parent), basename(path))
  }
}
