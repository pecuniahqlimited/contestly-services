/**
 * Whose chat lines each person doesn't see (ADR 0014): blocked either way, or muted by them. Rooms deliver a line
 * per client and skip the clients it's hidden from, so filtering is on the server. One cache per process, shared
 * by its rooms: refreshed when the safety channel says a block or mute between these people changed, and after a
 * short time anyway (a missed pub/sub message never sticks).
 */
import { chatHiddenAuthors, db } from "@contestly/db";

const FRESH_MS = 30_000;

export class HiddenAuthors {
  private cache = new Map<string, { at: number; set: Promise<Set<string>> }>();
  constructor(private load: (userId: string) => Promise<Set<string>> = (id) => chatHiddenAuthors(db, id), private now = () => Date.now()) {}

  of(userId: string): Promise<Set<string>> {
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < FRESH_MS) return hit.set;
    const set = this.load(userId);
    this.cache.set(userId, { at: this.now(), set });
    set.catch(() => this.cache.delete(userId)); // a failed load is tried again next time
    return set;
  }

  forget(userIds: string[]) {
    for (const id of userIds) this.cache.delete(id);
  }

  /** Whether `viewerId` should get a line by `authorId` (system lines have none; your own always reach you). */
  async sees(viewerId: string | undefined, authorId: string | null | undefined): Promise<boolean> {
    if (!viewerId || !authorId || viewerId === authorId) return true;
    return !(await this.of(viewerId)).has(authorId);
  }
}

export const hiddenAuthors = new HiddenAuthors();
