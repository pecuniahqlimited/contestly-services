import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, deviceView, registerDevice, removeDevicesOf, reportNudge, unregisterDevice, users } from "@contestly/db";
import { NUDGE_CATEGORIES, deviceRegisterSchema, deviceSchema, notificationSettingsPatchSchema, notificationSettingsSchema, nudgeReportSchema, togglesFromOff } from "@contestly/shared";
import { requireSession, uuidParam } from "../auth.js";
import { httpError } from "../httpError.js";
import { installIdOf } from "../signals.js";

const installIdRequired = () => httpError(400, "install_id_required");

/**
 * Devices, notification settings and nudge reports (row 9). Guests too: they get the guest follow-up. Opting in
 * to push is the app's (at the first concrete moment, never at launch); the API records each device's state.
 */
export async function notificationsRoutes(app: FastifyInstance) {
  /** Register or update this install (x-install-id): its token, permission, app version, and the account's zone. */
  app.put("/me/device", async (req) => {
    const me = requireSession(req);
    const installId = installIdOf(req);
    if (!installId) throw installIdRequired();
    return deviceSchema.parse(deviceView(await registerDevice(me.id, installId, deviceRegisterSchema.parse(req.body))));
  });

  /** This install stops getting pushes for this account. */
  app.delete("/me/device", async (req) => {
    const me = requireSession(req);
    const installId = installIdOf(req);
    if (!installId) throw installIdRequired();
    return { removed: await unregisterDevice(me.id, installId) };
  });

  /**
   * Signing out: this install's push token goes (without an install id, every device of the account's, so a
   * signed-out phone is never left getting someone's pushes). Firebase's own sign-out stays in the app.
   */
  app.post("/me/sign-out", async (req) => {
    const me = requireSession(req);
    const installId = installIdOf(req);
    return { devicesRemoved: installId ? Number(await unregisterDevice(me.id, installId)) : await removeDevicesOf(db, me.id) };
  });

  app.get("/me/notifications", async (req) => {
    const me = requireSession(req);
    return notificationSettingsSchema.parse({ toggles: togglesFromOff(me.nudgesOff), timeZone: me.timeZone });
  });

  /** Turn categories on or off, and/or set the zone (quiet hours and "a day" follow it). */
  app.patch("/me/notifications", async (req) => {
    const me = requireSession(req);
    const body = notificationSettingsPatchSchema.parse(req.body);
    const toggles = { ...togglesFromOff(me.nudgesOff), ...body.toggles };
    const [u] = await db.update(users).set({ nudgesOff: NUDGE_CATEGORIES.filter((c) => !toggles[c]), ...(body.timeZone ? { timeZone: body.timeZone } : {}) })
      .where(eq(users.id, me.id)).returning();
    return notificationSettingsSchema.parse({ toggles: togglesFromOff(u.nudgesOff), timeZone: u.timeZone });
  });

  /** The app tapped (opened) or swiped away (dismissed) a nudge, push or banner. The first report of each sticks. */
  for (const what of ["opened", "dismissed"] as const) {
    app.post(`/me/nudges/:id/${what}`, async (req) => {
      const row = await reportNudge(requireSession(req).id, uuidParam(req), what);
      if (!row) throw httpError(404, "not_found");
      return nudgeReportSchema.parse(row);
    });
  }
}
