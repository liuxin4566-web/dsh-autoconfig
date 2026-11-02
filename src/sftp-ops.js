/** Promise wrappers around the ssh2 SFTP subsystem (POSIX remote paths). */
import { posix } from "node:path";

export function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      sftp[method](...args, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function openSftp(client) {
  return new Promise((resolve, reject) => {
    try {
      client.sftp((error, sftp) => {
        if (error) reject(error);
        else resolve(sftp);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function mapEntry(basePath, entry) {
  const attrs = entry.attrs ?? {};
  const mode = Number(attrs.mode ?? 0);
  return {
    name: entry.filename,
    isDirectory: (mode & 0o170000) === 0o040000,
    size: Number(attrs.size ?? 0),
    // ssh2 reports seconds; the panel expects milliseconds.
    mtime: Number(attrs.mtime ?? 0) * 1000,
    mode
  };
}

export async function listDirectory(sftp, path = ".") {
  const target = path === "" ? "." : path;
  const entries = await sftpCall(sftp, "readdir", target);
  return entries.map((entry) => mapEntry(target, entry));
}

export async function statPath(sftp, path) {
  const attrs = await sftpCall(sftp, "stat", path);
  const mode = Number(attrs.mode ?? 0);
  return {
    isDirectory: (mode & 0o170000) === 0o040000,
    size: Number(attrs.size ?? 0),
    mtime: Number(attrs.mtime ?? 0) * 1000,
    mode
  };
}

/** ssh2's SFTP read callback is (err, bytesRead, buffer, position). */
function readHandle(sftp, handle, length, position) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length);
    sftp.read(handle, buffer, 0, length, position, (error, bytesRead, chunk) => {
      if (error) reject(error);
      else resolve((chunk ?? buffer).subarray(0, Number(bytesRead) || 0));
    });
  });
}

/** Read at most `maxBytes` from a remote file without loading the rest. */
export async function readFileBounded(sftp, path, maxBytes) {
  const attrs = await sftpCall(sftp, "stat", path);
  const size = Number(attrs.size ?? 0);
  const want = Math.max(1, Math.min(maxBytes, size === 0 ? 1 : size));
  const handle = await sftpCall(sftp, "open", path, "r");
  const chunks = [];
  let offset = 0;
  try {
    while (offset < want) {
      const length = Math.min(64 * 1024, want - offset);
      const chunk = await readHandle(sftp, handle, length, offset);
      if (!chunk || chunk.length === 0) break;
      chunks.push(chunk);
      offset += chunk.length;
    }
  } finally {
    await sftpCall(sftp, "close", handle).catch(() => {});
  }
  return { data: Buffer.concat(chunks), size, truncated: size > offset };
}

export async function writeFile(sftp, path, buffer) {
  await sftpCall(sftp, "writeFile", path, buffer);
  return { path, bytes: buffer.length };
}

export async function makeDirectory(sftp, path) {
  await sftpCall(sftp, "mkdir", path);
  return { path };
}

export async function removePath(sftp, path) {
  const info = await statPath(sftp, path);
  if (info.isDirectory) await sftpCall(sftp, "rmdir", path);
  else await sftpCall(sftp, "unlink", path);
  return { path, isDirectory: info.isDirectory };
}

export async function renamePath(sftp, from, to) {
  await sftpCall(sftp, "rename", from, to);
  return { from, to };
}

export function joinRemote(base, name) {
  return posix.join(base === "" ? "." : base, name);
}

export function parentRemote(path) {
  const parent = posix.dirname(path === "" ? "/" : path);
  return parent === "" ? "/" : parent;
}
