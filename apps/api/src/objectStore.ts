/** The object store media goes to (voice notes, images), made from env on first use. */
import { objectStoreFromEnv, type ObjectStore } from "@contestly/storage";

let store: ObjectStore | undefined;
export const storage = (): ObjectStore => (store ??= objectStoreFromEnv());
