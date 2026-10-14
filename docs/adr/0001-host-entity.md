# ADR 0001: How a party records its host

**Status:** Proposed — awaiting decision, no schema changed yet
**Date:** 2026-10-14

## Context

A party is always created by a specific user (we keep that), and is publicly hosted by either
that person or a brand. Brands arrive properly in roadmap step 4 (brand profiles, teams, a
member hosting *on behalf of* the brand); today the scaffold has only `users.is_brand` and
`parties.host_id → users.id`, both placeholders.

Two options were argued (CLAUDE.md, open question 1):

- **(a)** `parties.created_by_user_id` (always set) + nullable `parties.brand_id`; who the
  public host is falls out of whether `brand_id` is set.
- **(b)** a `hosts` table whose row is either a user or a brand (XOR check constraint), with
  `parties.host_id → hosts.id`.

## Option A: creator column + nullable brand column

```
parties.created_by_user_id  uuid NOT NULL → users.id   -- who clicked create; never null
parties.brand_id            uuid NULL     → brands.id  -- set ⇢ the brand is the public host
```

Public host = the brand when `brand_id` is set, else the creator. One rule, kept in one shared
helper (`packages/db`), never re-derived ad hoc in routes.

- **For:** no new table, no polymorphism; the creator is a plain FK you can always query;
  step 1 ships with just the rename (`host_id` → `created_by_user_id`) because brands don't
  exist yet — `brand_id` lands in step 4 when the `brands` table takes its real shape.
- **Against:** every consumer must apply the coalesce rule to display the host; a host-scoped
  key for recsys ("not interested in this host") is the pair, expressed as
  `COALESCE(brand_id, created_by_user_id)`; a third host kind later means another nullable
  column.

## Option B: a hosts table

```
hosts.id        uuid PK
hosts.user_id   uuid NULL → users.id   ┐ exactly one set
hosts.brand_id  uuid NULL → brands.id  ┘ (CHECK constraint)
parties.host_id uuid NOT NULL → hosts.id
parties.created_by_user_id uuid NOT NULL → users.id   -- still needed: hosts says who hosts, not who created
```

- **For:** one stable FK for anything host-scoped (host stats, follow-a-host, recsys keys);
  a third host kind is a new column in one table, not on every consumer.
- **Against:** it doesn't remove the creator column, it adds a table on top; the polymorphism
  is still there, just moved — every read joins `hosts` and *then* `users` or `brands` to get a
  name and avatar (two joins instead of one), and every consumer still branches on which side
  is set; host rows must be created lazily (first time a user or brand hosts) which is
  write-path machinery and a dedupe concern for no query we can name today; and it forces us
  to invent `hosts` *and* commit to a `brands` FK now, in step 1, before step 4 has designed
  brands.

## Recommendation: Option A

The decisive points:

1. **B pays now for flexibility we may never draw on.** The one scenario where B clearly wins
   is a third host kind (e.g. communities hosting parties) — explicitly "later, maybe" in the
   product direction. If that lands, migrating A → B is mechanical (backfill one row per
   distinct host, repoint one FK).
2. **B doesn't actually unify identity.** Display, verification badge, avatar and profile link
   all live on `users` or `brands` either way; B's indirection saves no branch at read time.
3. **A matches the build order.** Step 1 needs only the rename; `brand_id` waits for step 4 so
   we don't guess the brands table's shape today. B would force that guess now.
4. **The product already treats people and brands differently** (follows, verification,
   messaging rules), so a unified host ID buys less than it appears to.

Accepted trade-off: the "who is the public host" rule lives in a shared helper and consumers
must use it. No separate "host type" flag column — it would denormalise what `brand_id`'s
nullness already says.

## Consequence for step 1 (once approved)

Rename `parties.host_id` → `parties.created_by_user_id` and route everything that resolves the
public host through one helper in `packages/db`. No `brand_id`, no `brands` table until step 4.
