/**
 * A brand team's roles (ADR 0017), on their own so the root can name them (a corner viewer's brandRole) without
 * taking anything from brands.ts itself: a tree-shaking app then leaves brands.ts, and images.ts behind it, out of
 * its startup. brands.ts re-exports them with the rest of the brands contract.
 */
export const BRAND_ROLES = ["owner", "admin", "host", "viewer"] as const;
export type BrandRole = (typeof BRAND_ROLES)[number];
