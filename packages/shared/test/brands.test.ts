import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_BRAND_ROLES, BRAND_CAPABILITIES, BRAND_ROLES, CAC_NUMBER_RE, FULFILMENT_STATUSES, HOST_TEAM_ROLES, brandRoleCan, canMoveFulfilment, createBrandSchema,
  inviteBrandMemberSchema, normaliseCac, partyHasPrize,
} from "../src/index.js";

describe("brand roles (ADR 0017 §3)", () => {
  it("each role holds everything the one below it does, and the owner holds every capability", () => {
    const order = ["viewer", "host", "admin", "owner"] as const;
    for (let i = 1; i < order.length; i++) for (const c of BRAND_CAPABILITIES) if (brandRoleCan(order[i - 1], c)) expect(brandRoleCan(order[i], c), `${order[i]} ${c}`).toBe(true);
    expect(BRAND_CAPABILITIES.every((c) => brandRoleCan("owner", c))).toBe(true);
  });
  it("money out, ownership and deleting are the owner's alone", () => {
    for (const c of ["wallet.withdraw", "payout_accounts", "ownership", "delete"] as const) expect(BRAND_ROLES.filter((r) => brandRoleCan(r, c))).toEqual(["owner"]);
  });
  it("the team, settings and the wallet are admins' and up; hosting and fulfilling hosts' and up; viewers read", () => {
    for (const c of ["team.manage", "settings", "wallet.view", "wallet.topup", "corner.manage"] as const) expect(BRAND_ROLES.filter((r) => brandRoleCan(r, c))).toEqual(["owner", "admin"]);
    for (const c of ["parties.host", "inbox.write", "prizes.fulfil"] as const) expect(BRAND_ROLES.filter((r) => brandRoleCan(r, c))).toEqual(["owner", "admin", "host"]);
    expect(BRAND_ROLES.filter((r) => brandRoleCan(r, "inbox.read"))).toEqual([...BRAND_ROLES]);
    expect(HOST_TEAM_ROLES).toEqual(["owner", "admin", "host"]);
  });
  it("an invite never makes an owner", () => {
    expect(ASSIGNABLE_BRAND_ROLES).not.toContain("owner");
    expect(inviteBrandMemberSchema.safeParse({ handle: "ada.o", role: "owner" }).success).toBe(false);
    expect(inviteBrandMemberSchema.parse({ email: " Ada@Example.COM ", role: "host" })).toEqual({ email: "ada@example.com", role: "host" });
  });
});

describe("fulfilment steps", () => {
  it("the brand moves a prize forward; the winner disputes one arranged or delivered; nothing goes back to awarded", () => {
    expect(canMoveFulfilment("awarded", "arranged")).toBe(true);
    expect(canMoveFulfilment("awarded", "delivered")).toBe(false);
    expect(canMoveFulfilment("awarded", "disputed")).toBe(false);
    expect(canMoveFulfilment("arranged", "disputed")).toBe(true);
    expect(canMoveFulfilment("delivered", "disputed")).toBe(true);
    expect(canMoveFulfilment("disputed", "delivered")).toBe(true);
    for (const s of FULFILMENT_STATUSES) expect(canMoveFulfilment(s, "awarded")).toBe(false);
  });
});

describe("CAC numbers and handles", () => {
  it.each(["RC1234567", "rc 123456", "BN7654321", "IT 12345"])("accepts %s", (v) => expect(CAC_NUMBER_RE.test(v)).toBe(true));
  it.each(["1234567", "RC12", "AB123456", "RC123456789"])("refuses %s", (v) => expect(CAC_NUMBER_RE.test(v)).toBe(false));
  it("normalises to upper case without spaces", () => expect(normaliseCac(" rc 123 4567 ")).toBe("RC1234567"));
  it("a brand handle follows a person's rules (one namespace)", () => {
    expect(createBrandSchema.safeParse({ name: "Jollof Republic", handle: "jollof.republic" }).success).toBe(true);
    expect(createBrandSchema.safeParse({ name: "Jollof Republic", handle: "Jollof Republic" }).success).toBe(false);
    expect(createBrandSchema.safeParse({ name: "Jollof Republic", handle: "deleted_x1" }).success).toBe(false);
  });
});

describe("a party with a prize (the team's seat rule)", () => {
  const base = { entryKobo: 0, funding: "pooled", prizeKind: "cash", hostPoolKobo: 0 };
  it("an entry, a host's cash prize or goods is a prize; a free party isn't", () => {
    expect(partyHasPrize(base)).toBe(false);
    expect(partyHasPrize({ ...base, entryKobo: 20_000 })).toBe(true);
    expect(partyHasPrize({ ...base, funding: "host", hostPoolKobo: 50_000 })).toBe(true);
    expect(partyHasPrize({ ...base, funding: "host", prizeKind: "product" })).toBe(true);
  });
});
