/** The Climb's word list in the admin console: list, add one or paste many, edit, switch off. Every change is logged. */
import type { FastifyInstance } from "fastify";
import { db, existingWords, insertWords, listWords, lockWord, recordAdminAction, updateWord, wordAddedBy, type ClimbWordRow } from "@contestly/db";
import {
  addClimbWordsBodySchema, checkClimbWord, climbWordsQuerySchema, editClimbWordBodySchema, splitWordLines,
  type ClimbWord, type WordCheck,
} from "@contestly/shared";
import { requireAdmin, uuidParam } from "../auth.js";

const refused = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

const wordView = (w: ClimbWordRow, addedBy: { id: string; handle: string } | null): ClimbWord => ({
  id: w.id, word: w.word, active: w.active, games: w.games, theme: w.theme, addedBy,
  createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString(),
});
const logged = (w: ClimbWordRow) => ({ word: w.word, active: w.active, games: w.games, theme: w.theme });

export async function adminClimbWordsRoutes(app: FastifyInstance) {
  app.get("/admin/climb/words", async (req) => {
    requireAdmin(req);
    const { rows, total, activeByGame } = await listWords(climbWordsQuerySchema.parse(req.query));
    return { words: rows.map((r) => wordView(r.w, r.w.addedByUserId && r.handle ? { id: r.w.addedByUserId, handle: r.handle } : null)), total, activeByGame };
  });

  /** One word or a paste: a result per line (added, already on the list, a repeat within the paste, or invalid and why). */
  app.post("/admin/climb/words", async (req) => {
    const admin = requireAdmin(req);
    const { text, games, theme = null } = addClimbWordsBodySchema.parse(req.body);
    const lines = splitWordLines(text).map((l) => ({ ...l, check: checkClimbWord(l.input) as WordCheck }));
    const valid = [...new Set(lines.flatMap((l) => (l.check.ok ? [l.check.word] : [])))];
    return db.transaction(async (tx) => {
      const existing = await existingWords(tx, valid);
      const added = await insertWords(tx, valid.filter((w) => !existing.has(w)), { games, theme, addedByUserId: admin.id });
      const addedSet = new Set(added.map((w) => w.word));
      if (added.length) {
        await recordAdminAction(tx, { adminUserId: admin.id, action: "climb.words_add", targetType: "config", targetId: "climb_words", before: null, after: { words: added.map((w) => w.word), games, theme } });
      }
      const seen = new Set<string>();
      const results = lines.map(({ line, input, check }) => {
        if (!check.ok) return { line, input, word: null, result: "invalid" as const, error: check.error };
        const result = seen.has(check.word) ? "duplicate" as const : addedSet.has(check.word) ? "added" as const : "exists" as const;
        seen.add(check.word);
        return { line, input, word: check.word, result, error: null };
      });
      return { results, added: added.length };
    });
  });

  /** Change a word's games or theme, or switch it off or on. Rounds already made keep the words they were made with. */
  app.patch("/admin/climb/words/:id", async (req) => {
    const admin = requireAdmin(req);
    const id = uuidParam(req);
    const { reason, ...change } = editClimbWordBodySchema.parse(req.body);
    return db.transaction(async (tx) => {
      const before = await lockWord(tx, id);
      if (!before) throw refused("not_found", 404);
      const after = await updateWord(tx, id, change);
      const action = change.active === false && before.active ? "climb.word_deactivate" : change.active && !before.active ? "climb.word_activate" : "climb.word_edit";
      await recordAdminAction(tx, { adminUserId: admin.id, action, targetType: "config", targetId: `climb_word:${before.word}`, reason, before: logged(before), after: logged(after) });
      return wordView(after, await wordAddedBy(tx, after));
    });
  });
}
