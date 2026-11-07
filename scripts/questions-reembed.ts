/**
 * Queue the re-embedding job (ADR 0016): bank questions and file chunks embedded by another model are moved to
 * the questions service's current embedder, a batch at a time, until none are left. The service also queues it
 * at start when there's anything to move; this is for doing it on demand. Needs the questions service running.
 */
import { questionsQueue } from "@contestly/queue";

const queue = questionsQueue();
await queue.add("reembed", { kind: "reembed" }, { jobId: `reembed-${Date.now()}` });
console.log("reembed queued: the questions service works through it in batches (see its log)");
await queue.close();
process.exit(0);
