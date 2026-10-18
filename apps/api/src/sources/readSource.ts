/**
 * Read a source file in a worker thread so a large PDF never blocks the API's event loop. The bytes
 * are transferred to the worker, not copied: once this is called the caller's buffer is empty, and
 * nothing but the extracted chunks comes back. A read that runs too long is stopped.
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { READ_FAILURES, type ReadResult } from "./readChunks.js";

const READ_TIMEOUT_MS = 30_000;
/** read.worker.ts under tsx in dev, read.worker.js once built. */
const WORKER_URL = new URL(`./read.worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

export function readSource(contentType: string, bytes: Uint8Array): Promise<ReadResult> {
  // A small Buffer can be a view on Node's shared pool; transferring that would empty other buffers. Copy it out first.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { contentType, bytes: own }, transferList: [own.buffer as ArrayBuffer] });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ ok: false, reason: READ_FAILURES.tooSlow });
    }, READ_TIMEOUT_MS);
    worker.once("message", (result: ReadResult) => {
      clearTimeout(timer);
      resolve(result);
      void worker.terminate();
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
