/**
 * Brands and teams (ADR 0017): making a brand, its public profile, settings and verification checklist, the team
 * (invites by handle or email, roles, removing, leaving, hand-over), its parties and goods prizes, and deleting it.
 * Every brand action checks the person's role through assertBrandCan(); the brand is named in the path here, and
 * acting as it elsewhere (wallet, chats, corner, party creation) is the x-act-as header.
 */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import {
  answerInvite, assertBrandCan, brandsOf, changeRole, createBrand, db, deleteBrand, disputePrize, fulfilPrize, handOver, inviteMember, leaveBrand, liveBrand,
  parties, prizesOwedBy, prizesWonBy, removeMember, revokeInvite, setBusinessEmail, submitForReview, teamOf, updateBrand,
} from "@contestly/db";
import {
  brandEmailStartSchema, brandEmailVerifySchema, deleteBrandSchema, brandHandOverSchema, brandRoleChangeSchema, brandSettingsSchema, brandTeamResponseSchema, createBrandSchema,
  fulfilmentDisputeSchema, fulfilmentUpdateSchema, inviteBrandMemberSchema, myBrandsResponseSchema, prizeFulfilmentsResponseSchema, publicBrandSchema, updateBrandSchema,
} from "@contestly/shared";
import { optionalSession, requireUser, uuidParam } from "../auth.js";
import { httpError } from "../httpError.js";
import { cornerIdsOf, inviteView, memberView, personView, publicBrandView, settingsView } from "../brands.js";
import { checkEmailCode, startEmailCode, watchCodeSends } from "../signin/emailCode.js";
import { sendBrandInvite, sendBusinessEmailCode } from "../email.js";
import { partySummaries } from "../partySummaries.js";

const BRAND_PARTIES_SHOWN = 50;
const userIdParam = (req: { params: unknown }) => uuidParam(req as never, "userId");

export async function brandsRoutes(app: FastifyInstance) {
  /** Make a brand: the signed-in person (verified email or phone) becomes its owner. 409 handle_taken. */
  app.post("/brands", async (req, reply) => {
    const me = requireUser(req);
    const { account, brand } = await createBrand(me, createBrandSchema.parse(req.body));
    return reply.code(201).send(brandSettingsSchema.parse(await settingsView(account, brand, "owner")));
  });

  /** The profile switcher: my brands with my role, and invites waiting for me. */
  app.get("/me/brands", async (req) => {
    const me = requireUser(req);
    const { memberships, invites } = await brandsOf(me.id);
    const cornerOf = await cornerIdsOf([...memberships.map((m) => m.account.id), ...invites.map((i) => i.account.id)]);
    return myBrandsResponseSchema.parse({
      brands: memberships.map((m) => ({ ...publicBrandView(m.account, m.brand, cornerOf.get(m.account.id) ?? null), role: m.role, verificationStatus: m.brand.verificationStatus })),
      invites: invites.map((i) => ({
        id: i.invite.id, brand: publicBrandView(i.account, i.brand, cornerOf.get(i.account.id) ?? null), role: i.invite.role, invitedBy: personView(i.inviter), createdAt: i.invite.createdAt.toISOString(),
      })),
    });
  });

  for (const [answer, accept] of [["accept", true], ["decline", false]] as const) {
    /** Answer an invite to me (accept puts me on the team with its role). */
    app.post(`/brand-invites/:id/${answer}`, async (req) => answerInvite(uuidParam(req), requireUser(req), accept));
  }

  /** A brand's public profile: anyone, signed in or not. */
  app.get("/brands/:id", async (req) => {
    optionalSession(req);
    const found = await liveBrand(db, uuidParam(req));
    if (!found) throw httpError(404, "not_found");
    return publicBrandSchema.parse(publicBrandView(found.account, found.brand, (await cornerIdsOf([found.account.id])).get(found.account.id) ?? null));
  });

  /** Settings, the checklist and my role (every role reads; settings writes). */
  app.get("/brands/:id/settings", async (req) => {
    const { account, brand, role } = await assertBrandCan(db, uuidParam(req), requireUser(req), "view");
    return brandSettingsSchema.parse(await settingsView(account, brand, role));
  });

  app.patch("/brands/:id", async (req) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    await updateBrand(id, me, updateBrandSchema.parse(req.body));
    const { account, brand, role } = await assertBrandCan(db, id, me, "view");
    return brandSettingsSchema.parse(await settingsView(account, brand, role));
  });

  /** The business email: a 6-digit code to the address, bound to this person and this brand. */
  app.post("/brands/:id/business-email/start", async (req) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    const { account, brand } = await assertBrandCan(db, id, me, "settings");
    const { email } = brandEmailStartSchema.parse(req.body);
    if (brand.verificationStatus === "verified" && brand.businessEmail !== email) throw httpError(409, "brand_email_locked");
    const sent = await startEmailCode(me, email, req.clientIp, app.limits, `brand_email:${id}`, (to, code) => sendBusinessEmailCode(to, code, account.displayName));
    await watchCodeSends(app.limits.codeSendsAlertPerHour);
    return sent;
  });
  app.post("/brands/:id/business-email/verify", async (req) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    await assertBrandCan(db, id, me, "settings");
    const { email, code } = brandEmailVerifySchema.parse(req.body);
    await checkEmailCode(me, email, code, req.clientIp, app.limits, `brand_email:${id}`);
    await setBusinessEmail(id, me, email);
    const { account, brand, role } = await assertBrandCan(db, id, me, "view");
    return brandSettingsSchema.parse(await settingsView(account, brand, role));
  });

  /** Send for review once the checklist is complete (422 checklist_incomplete with what's missing). */
  app.post("/brands/:id/verification/submit", async (req) => submitForReview(uuidParam(req), requireUser(req)));

  // ---- the team ----

  app.get("/brands/:id/team", async (req) => {
    const id = uuidParam(req);
    await assertBrandCan(db, id, requireUser(req), "view");
    const { members, invites, people } = await teamOf(id);
    return brandTeamResponseSchema.parse({ members: members.map(memberView), invites: invites.map((i) => inviteView(i, people)) });
  });

  /**
   * Invite by handle, or by email for someone who may not be on the app (they're emailed, and the invite waits on
   * their account once they sign up with that address). Asking again answers with the open invite (replayed).
   */
  app.post("/brands/:id/invites", async (req, reply) => {
    const me = requireUser(req);
    const input = inviteBrandMemberSchema.parse(req.body);
    const out = await inviteMember(uuidParam(req), me, input);
    if (!out.replayed && "email" in out.to) {
      const sent = await sendBrandInvite(out.to.email, out.brandName, out.inviterName, input.role);
      if (!sent.deliveredBy) req.log.warn({ inviteId: out.inviteId }, "brand invite email not delivered");
    }
    return reply.code(out.replayed ? 200 : 201).send({ inviteId: out.inviteId, to: "email" in out.to ? "email" : "account", replayed: out.replayed });
  });
  app.delete("/brands/:id/invites/:inviteId", async (req, reply) => {
    await revokeInvite(uuidParam(req), requireUser(req), uuidParam(req, "inviteId"));
    return reply.code(204).send();
  });

  app.patch("/brands/:id/members/:userId", async (req, reply) => {
    await changeRole(uuidParam(req), requireUser(req), userIdParam(req), brandRoleChangeSchema.parse(req.body).role);
    return reply.code(204).send();
  });
  app.delete("/brands/:id/members/:userId", async (req, reply) => {
    await removeMember(uuidParam(req), requireUser(req), userIdParam(req));
    return reply.code(204).send();
  });
  app.post("/brands/:id/leave", async (req, reply) => {
    await leaveBrand(uuidParam(req), requireUser(req));
    return reply.code(204).send();
  });
  /** Hand ownership to a member; the old owner becomes an admin. */
  app.post("/brands/:id/owner", async (req, reply) => {
    await handOver(uuidParam(req), requireUser(req), brandHandOverSchema.parse(req.body).userId);
    return reply.code(204).send();
  });

  /** The owner deletes the brand (ADR 0010's soft delete of its account): 409 with the blockers if it can't go yet. */
  app.delete("/brands/:id", async (req, reply) => {
    const { reason } = deleteBrandSchema.parse(req.body ?? {});
    await deleteBrand(uuidParam(req), requireUser(req), reason ?? null);
    return reply.code(204).send();
  });

  // ---- parties and prizes ----

  /** The brand's parties, newest first (every role sees them). */
  app.get("/brands/:id/parties", async (req) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    await assertBrandCan(db, id, me, "view");
    const rows = await db.select().from(parties).where(eq(parties.brandId, id)).orderBy(desc(parties.startsAt)).limit(BRAND_PARTIES_SHOWN);
    return { parties: await partySummaries(rows, me.id) };
  });

  /** Goods prizes the brand owes, newest first. */
  app.get("/brands/:id/prizes", async (req) => {
    const id = uuidParam(req);
    await assertBrandCan(db, id, requireUser(req), "view");
    return prizeFulfilmentsResponseSchema.parse({ prizes: await prizesOwedBy(id) });
  });
  /** Arranged (the winner hears it's on its way), then delivered. */
  app.post("/brands/:id/prizes/:fid", async (req) => {
    const { status, note } = fulfilmentUpdateSchema.parse(req.body);
    return fulfilPrize(uuidParam(req), requireUser(req), uuidParam(req, "fid"), status, note ?? null);
  });

  /** Goods prizes I've won. */
  app.get("/me/prizes", async (req) => prizeFulfilmentsResponseSchema.parse({ prizes: await prizesWonBy(requireUser(req).id) }));
  /** It hasn't come, or isn't what was promised. */
  app.post("/me/prizes/:fid/dispute", async (req) => disputePrize(requireUser(req).id, uuidParam(req, "fid"), fulfilmentDisputeSchema.parse(req.body).note));

}
