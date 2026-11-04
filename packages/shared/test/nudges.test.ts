import { describe, expect, it } from "vitest";
import {
  DEEP_LINKS, MoneyInNudge, NUDGE_KINDS, parseThreadLink, NUDGE_KIND_NAMES, actorsLine, inQuietHours, localClock, mentionsMoney, renderNudge, startOfLocalDay, togglesFromOff,
  DEFAULT_NUDGE_CONFIG, deviceRegisterSchema, notificationSettingsPatchSchema, type NudgeData, type NudgeKind,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
/** Neutral data for every kind: what the emitters record. */
const SAMPLE: { [K in NudgeKind]: NudgeData[K] } = {
  party_starting: { partyId: id, title: "Friday Night Quiz", minutes: 5 },
  party_live: { partyId: id, title: "Friday Night Quiz" },
  people_joined: { partyId: id, title: "Friday Night Quiz" },
  party_filling: { partyId: id, title: "Friday Night Quiz", lane: "Football" },
  corner_party: { partyId: id, title: "Friday Night Quiz", cornerId: id, cornerName: "Kemi's corner" },
  mention: { thread: { kind: "party", partyId: id }, where: "Friday Night Quiz chat" },
  corner_reply: { cornerId: id, postId: id },
  corner_follow_ask: { cornerId: id, cornerName: "Kemi's corner", hostName: "Kemi" },
  corner_open: { cornerId: id },
  rival: { by: "head_to_head", rivalHandle: "kemz", rivalName: "Kemi", them: 4, you: 3 },
  streak_risk: { days: 6 },
  host_cancelled: { partyId: id, title: "Friday Night Quiz", entryBack: true },
  guest_follow_up: { partyId: id, title: "Friday Night Quiz" },
  win_back: { personName: "Kemi", personHandle: "kemz", what: "hosted 2 parties" },
};

describe("the no-money guard", () => {
  it.each(["Win ₦50,000 tonight", "₦200 entry", "Top prize: NGN 5000", "50k up for grabs", "1.5m naira", "10,000 to win", "cash prize", "win real money", "Your refund is in", "payout ready", "$20", "Jackpot quiz"])(
    "rejects %s", (text) => expect(mentionsMoney(text)).toBe(true));

  it.each(["Ada and 2 others joined Friday Night Quiz", "Friday Night Quiz starts in 5 minutes", "They reached stage 4", "Head to head: 4–3", "Your 6-day streak ends at midnight", "Spot the difference"])(
    "lets %s through", (text) => expect(mentionsMoney(text)).toBe(false));

  it("throws when copy mentions money, whoever wrote it (a party's title)", () => {
    expect(() => renderNudge("party_live", { partyId: id, title: "Win ₦100k" })).toThrow(MoneyInNudge);
  });

  it("every kind's own copy passes it", () => {
    for (const kind of NUDGE_KIND_NAMES) {
      const c = renderNudge(kind, SAMPLE[kind] as never, [{ id, name: "Ada" }, { id: "b", name: "Kemi" }, { id: "c", name: "Tunde" }]);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.deepLink).toMatch(/^contestly:\/\//);
      expect(c.reason.length).toBeGreaterThan(0);
    }
    expect(renderNudge("party_starting", { ...SAMPLE.party_starting, minutes: 1 }).title).toBe("Friday Night Quiz starts in a minute");
    expect(renderNudge("rival", { by: "climb", rivalHandle: "kemz", rivalName: "Kemi", stage: 4 }).title).toBe("Kemi climbed past your best");
  });

  it("the host's cancel never says refund, in the title or anywhere", () => {
    const c = renderNudge("host_cancelled", SAMPLE.host_cancelled);
    expect(c.title).toBe("The host cancelled Friday Night Quiz");
    expect(`${c.title} ${c.body}`).not.toMatch(/refund/i);
  });

  it("every kind has a category, and only party start and live are live-party events", () => {
    const live = NUDGE_KIND_NAMES.filter((k) => NUDGE_KINDS[k].livePartyEvent);
    expect(live.sort()).toEqual(["party_live", "party_starting"]);
  });
});

describe("thread links", () => {
  it("carry the thread's kind and reference, and read back the same", () => {
    const threads = [
      { kind: "dm", handle: "ada.o" }, { kind: "crew", crewId: id }, { kind: "party", partyId: id }, { kind: "corner_post", postId: id },
    ] as const;
    for (const t of threads) expect(parseThreadLink(DEEP_LINKS.thread(t))).toEqual(t);
    expect(DEEP_LINKS.thread({ kind: "dm", handle: "kemz" })).toBe("contestly://chats/dm/kemz");
  });

  it("anything else isn't a thread link", () => {
    for (const link of ["contestly://chats/x", "contestly://chats/crew/not-a-uuid", "contestly://chats/group/x", "contestly://party/" + id, "https://chats/dm/kemz"]) {
      expect(parseThreadLink(link)).toBeNull();
    }
  });

  it("mentions and corner replies link to their thread", () => {
    expect(renderNudge("mention", SAMPLE.mention, [{ id, name: "Ada" }]).deepLink).toBe(`contestly://chats/party/${id}`);
    expect(renderNudge("corner_reply", SAMPLE.corner_reply, [{ id, name: "Ada" }]).deepLink).toBe(`contestly://chats/corner_post/${id}`);
  });
});

describe("batched copy", () => {
  it("names one or two, then counts the rest", () => {
    expect(actorsLine([{ id: "a", name: "Ada" }])).toBe("Ada");
    expect(actorsLine([{ id: "a", name: "Ada" }, { id: "b", name: "Kemi" }])).toBe("Ada and Kemi");
    expect(actorsLine([{ id: "a", name: "Ada" }, { id: "b", name: "Kemi" }, { id: "c", name: "Tunde" }])).toBe("Ada and 2 others");
    expect(renderNudge("people_joined", SAMPLE.people_joined, [{ id: "a", name: "Ada" }, { id: "b", name: "Kemi" }, { id: "c", name: "Tunde" }]).title)
      .toBe("Ada and 2 others joined Friday Night Quiz");
  });
});

describe("time zones and quiet hours", () => {
  const q = DEFAULT_NUDGE_CONFIG.quietHours;
  // 03:30Z: 22:30 the evening before in New York (EST, UTC-5), 04:30 in Lagos.
  const at = new Date("2026-11-04T03:30:00Z");

  it("reads the wall clock where the person is", () => {
    expect(localClock(at, "America/New_York")).toEqual({ day: "2026-11-03", hour: 22, minute: 30 });
    expect(localClock(at, "Africa/Lagos")).toEqual({ day: "2026-11-04", hour: 4, minute: 30 });
  });

  it("is quiet from 23:00 to 07:00 their time, not Lagos time", () => {
    expect(inQuietHours(at, "Africa/Lagos", q)).toBe(true);
    expect(inQuietHours(at, "America/New_York", q)).toBe(false);
    expect(inQuietHours(new Date("2026-11-04T04:00:00Z"), "America/New_York", q)).toBe(true); // 23:00 NY
    expect(inQuietHours(new Date("2026-11-04T12:00:00Z"), "America/New_York", q)).toBe(false); // 07:00 NY
    expect(inQuietHours(new Date("2026-11-04T11:59:00Z"), "America/New_York", q)).toBe(true); // 06:59 NY
  });

  it("a day for caps starts at their midnight", () => {
    expect(startOfLocalDay(at, "America/New_York").toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(startOfLocalDay(at, "Africa/Lagos").toISOString()).toBe("2026-11-03T23:00:00.000Z");
  });

  it("only takes zones the runtime knows", () => {
    const base = { platform: "ios", token: "t", appVersion: "1.0.0", permission: "granted" } as const;
    expect(deviceRegisterSchema.safeParse({ ...base, timeZone: "Europe/London" }).success).toBe(true);
    expect(deviceRegisterSchema.safeParse({ ...base, timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(notificationSettingsPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("toggles", () => {
  it("are stored as what's off; everything else is on", () => {
    expect(togglesFromOff(["climb"])).toEqual({ parties: true, corners: true, people: true, mentions: true, climb: false, account: true });
  });
});
