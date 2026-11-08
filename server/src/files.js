import { promises as fs, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_EDIT_BYTES = 512 * 1024;

export class FileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Confines everything to `root`. Paths are relative to it; ".." and anything that resolves
// (through symlinks) to outside it is refused.
export function createFiles(root) {
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new FileError("The files folder for this server doesn't exist on this machine", 404);
  }

  function inside(p) {
    return p === rootReal || p.startsWith(rootReal + path.sep);
  }

  function resolve(rel, { mustExist }) {
    if (rel === undefined || rel === null) rel = "";
    if (typeof rel !== "string" || rel.includes("\0") || rel.length > 1024) throw new FileError("Bad path");
    const parts = rel.split("/").filter((p) => p && p !== ".");
    if (parts.includes("..")) throw new FileError("Bad path");
    const full = path.join(rootReal, ...parts);
    if (existsSync(full)) {
      const real = realpathSync(full);
      if (!inside(real)) throw new FileError("That path leaves the server folder", 403);
      return { full: real, rel: parts.join("/") };
    }
    if (mustExist) throw new FileError("No such file or folder", 404);
    const parent = path.dirname(full);
    if (!existsSync(parent)) throw new FileError("The folder doesn't exist", 404);
    if (!inside(realpathSync(parent))) throw new FileError("That path leaves the server folder", 403);
    return { full: path.join(realpathSync(parent), path.basename(full)), rel: parts.join("/") };
  }

  return {
    async list(rel) {
      const { full, rel: clean } = resolve(rel, { mustExist: true });
      const st = await fs.stat(full);
      if (!st.isDirectory()) throw new FileError("Not a folder");
      const names = await fs.readdir(full);
      const entries = [];
      for (const name of names.slice(0, 2000)) {
        try {
          const real = realpathSync(path.join(full, name));
          if (!inside(real)) continue; // a symlink pointing out of the folder is hidden
          const s = await fs.stat(real);
          entries.push({ name, type: s.isDirectory() ? "dir" : "file", size: s.isDirectory() ? null : s.size, mtime: Math.floor(s.mtimeMs) });
        } catch {
          /* broken link or vanished file */
        }
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return { path: clean, entries };
    },

    async read(rel) {
      const { full, rel: clean } = resolve(rel, { mustExist: true });
      const st = await fs.stat(full);
      if (st.isDirectory()) throw new FileError("That's a folder");
      if (st.size > MAX_EDIT_BYTES) throw new FileError(`Too big to edit here (${Math.round(st.size / 1024)} KB, limit ${MAX_EDIT_BYTES / 1024} KB)`, 413);
      const buf = await fs.readFile(full);
      if (buf.includes(0)) throw new FileError("This looks like a binary file, so it can't be edited here", 415);
      return { path: clean, content: buf.toString("utf8"), size: st.size, mtime: Math.floor(st.mtimeMs) };
    },

    // expectedMtime: the mtime the editor loaded. If the file changed since, refuse (a plugin or the game may have rewritten it).
    async write(rel, content, expectedMtime) {
      if (typeof content !== "string") throw new FileError("content must be text");
      if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new FileError("Too big to save here", 413);
      if (content.includes("\0")) throw new FileError("Binary content isn't allowed");
      const { full, rel: clean } = resolve(rel, { mustExist: false });
      if (!clean) throw new FileError("Pick a file name");
      let mode = 0o644;
      if (existsSync(full)) {
        const st = await fs.stat(full);
        if (st.isDirectory()) throw new FileError("That's a folder");
        if (expectedMtime !== undefined && expectedMtime !== null && Math.floor(st.mtimeMs) !== expectedMtime) {
          throw new FileError("This file changed on the server since you opened it. Reload it and redo your edit.", 409);
        }
        mode = st.mode & 0o777;
      } else if (expectedMtime) {
        throw new FileError("This file was deleted since you opened it.", 409);
      }
      const tmp = path.join(path.dirname(full), `.console-${randomBytes(6).toString("hex")}.tmp`);
      try {
        await fs.writeFile(tmp, content, { mode });
        await fs.rename(tmp, full); // atomic: the server never reads a half-written config
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw new FileError(`Couldn't save: ${e.code === "EACCES" ? "permission denied for the console user" : e.message}`, 500);
      }
      const st = await fs.stat(full);
      return { path: clean, size: st.size, mtime: Math.floor(st.mtimeMs) };
    },
  };
}
