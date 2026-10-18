/**
 * Worker-thread entry: turn a source file's bytes into chunks of text, off the API's event loop.
 * The bytes arrive transferred (the request handler no longer holds them) and are dropped when this
 * returns; only the chunks go back. See readSource.ts.
 */
import { parentPort, workerData } from "node:worker_threads";
import { readChunks, type ReadInput } from "./readChunks.js";

parentPort!.postMessage(await readChunks(workerData as ReadInput));
