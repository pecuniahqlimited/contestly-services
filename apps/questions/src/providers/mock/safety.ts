/** The mock safety reviewer: passes everything, so only the shared term filter judges (tests, dev without keys). */
import type { SafetyReviewer } from "../types.js";

export const mockSafety: SafetyReviewer = {
  name: "mock",
  async review(_brief, items) {
    return items.map(() => ({ passed: true, reasons: [] }));
  },
};
