import { z } from "zod";

/** A person as a face, a list row or a mention shows them. */
export const personSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  isVerified: z.boolean(),
});
export type Person = z.infer<typeof personSchema>;
