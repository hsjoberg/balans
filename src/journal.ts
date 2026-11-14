import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const lockPath = (node: string, directory: string) => join(directory, `${createHash('sha256').update(node).digest('hex').slice(0, 24)}.lock`);
const existingLock = (lock: string) => new Error(`A session lock exists: ${lock}. Confirm the previous process has stopped and reconcile its payments in LND before manually removing the lock.`);

// Read-only preflight: execution still acquires the lock atomically after review.
export function checkSessionLock(node: string, directory = join(homedir(), '.balans')) {
  const lock = lockPath(node, directory);
  try { lstatSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Cannot check session lock: ${lock}. Check directory access and permissions.`);
  }
  throw existingLock(lock);
}

export function openJournal(node: string, directory = join(homedir(), '.balans')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = lockPath(node, directory);
  let lockFd: number;
  try { lockFd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw existingLock(lock);
    throw new Error(`Cannot create session lock: ${lock}. Check directory access and permissions.`);
  }
  const path = join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`);
  let fd: number;
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, node, journal: path }));
    fsyncSync(lockFd);
    fd = openSync(path, 'wx', 0o600);
  } catch (err) { closeSync(lockFd); unlinkSync(lock); throw err; }
  let closed = false;
  return {
    path,
    write(value: unknown) {
      writeFileSync(fd, JSON.stringify({ time: new Date().toISOString(), ...value as object }) + '\n');
      fsyncSync(fd);
    },
    close(keepLock = false) {
      if (closed) return;
      closed = true;
      closeSync(fd);
      closeSync(lockFd);
      if (!keepLock) unlinkSync(lock);
    },
  };
}
