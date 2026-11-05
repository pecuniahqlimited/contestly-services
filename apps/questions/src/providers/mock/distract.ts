/**
 * The mock generator's wrong options for a host-written question: deterministic from the question and answer.
 * A number gets nearby numbers (a year, nearby years); anything else gets words from the synthetic pool of a
 * similar length, capitalised like the answer.
 */
import { createHash } from "node:crypto";
import { WORDS } from "./synthetic.js";

const seedOf = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);
const NUMBER = /^-?\d+$/;
const YEAR_SPREAD = [-3, -1, 2, 5, -6, 4];
const NUMBER_SPREAD = [1, -1, 2, 3, -2, 5];

function nearbyNumbers(answer: string, count: number): string[] {
  const n = Number(answer);
  const year = n >= 1900 && n <= 2100;
  const spread = year ? YEAR_SPREAD : NUMBER_SPREAD.map((d) => d * Math.max(1, Math.round(Math.abs(n) / 10)));
  return spread.map((d) => String(n + d)).filter((v) => v !== answer && (n < 0 || Number(v) >= 0)).slice(0, count);
}

const likeAnswer = (word: string, answer: string) => (answer[0] === answer[0]?.toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase());

export function mockDistract(input: { question: string; answer: string; count: number }): string[] {
  const answer = input.answer.trim();
  if (NUMBER.test(answer)) return nearbyNumbers(answer, input.count);
  const near = WORDS.filter((w) => Math.abs(w.length - answer.length) <= 3 && w.toLowerCase() !== answer.toLowerCase());
  const pool = near.length >= input.count ? near : WORDS.filter((w) => w.toLowerCase() !== answer.toLowerCase());
  const start = seedOf(`${input.question}|${answer}`) % pool.length;
  const out: string[] = [];
  for (let i = 0; out.length < input.count && i < pool.length; i++) {
    const w = likeAnswer(pool[(start + i * 7) % pool.length], answer);
    if (!out.some((o) => o.toLowerCase() === w.toLowerCase())) out.push(w);
  }
  return out;
}
