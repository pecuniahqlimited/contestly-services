/**
 * Picture rounds are capped (ADR 0016): the image pool is a short code list until a licensed pool exists, so
 * a set takes at most a quarter of its play order as pictures, rounded down (`pictureCap()` in shared), reserves
 * included, never more than the pool has images, and never the same image twice. Applied to retrieved bank
 * questions, to what the generator is asked for, to its drafts before they're verified (so nothing is paid for a
 * picture that couldn't be used), and to the bank originals a fill falls back on.
 */
import { pictureCap, type QuestionFormat } from "@contestly/shared";

interface Item {
  format: QuestionFormat | string;
  payload: unknown;
}

/** How many picture rounds a set whose play order is `playSize` may hold, reserves included, with a pool of `poolSize` images. */
export const pictureLimit = (playSize: number, poolSize: number) => Math.max(0, Math.min(poolSize, pictureCap(playSize)));

const imageOf = (payload: unknown) => String((payload as { imageUrl?: unknown })?.imageUrl ?? "");

/** What's left of the cap after `inSet`: how many more pictures, and the images already used. */
export function pictureRoom(inSet: Item[], limit: number): { left: number; usedImages: Set<string> } {
  const pictures = inSet.filter((q) => q.format === "picture");
  return { left: Math.max(0, limit - pictures.length), usedImages: new Set(pictures.map((q) => imageOf(q.payload))) };
}

/**
 * Keeps every non-picture item, and pictures in order while there's room and their image is new; returns the
 * kept items and the room left after them. Pure: the caller's room isn't changed.
 */
export function withinPictureCap<T extends Item>(items: T[], room: { left: number; usedImages: Set<string> }): { kept: T[]; dropped: number; room: { left: number; usedImages: Set<string> } } {
  let left = room.left;
  const used = new Set(room.usedImages);
  const kept: T[] = [];
  let dropped = 0;
  for (const it of items) {
    if (it.format !== "picture") {
      kept.push(it);
      continue;
    }
    const image = imageOf(it.payload);
    if (left <= 0 || used.has(image)) {
      dropped++;
      continue;
    }
    left--;
    used.add(image);
    kept.push(it);
  }
  return { kept, dropped, room: { left, usedImages: used } };
}
