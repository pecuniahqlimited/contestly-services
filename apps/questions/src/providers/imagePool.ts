/**
 * The image pool picture questions are written about. Every image has alt text describing what it shows; a
 * generator may only use an image from here, so the engine never hot-links a web image. This is a code list
 * of the images we have until a licensed or generated pool exists (ADR 0016); picture rounds are therefore
 * limited to these subjects, and offered only to a set whose topic they fit (imagesFor): an image of Aso Rock has no
 * place in a WWE quiz.
 */
import type { GenerationSpec } from "./types.js";

export interface PoolImage {
  id: string;
  url: string;
  alt: string;
  /** What the picture is of, plainly: the fact a question about it rests on. */
  subject: string;
  /** Words in a brief that make the image on topic (matched at the start of a word). */
  topics: string[];
}

/** Every image here is of Nigeria: a brief about Nigeria, or a Geography set, may use any of them. */
const NIGERIA = ["nigeria", "naija", "9ja", "landmark", "tourist", "tourism"];
/** The categories whose sets the pool fits whatever the brief's words. */
const POOL_CATEGORIES = ["Geography"];

export const IMAGE_POOL: PoolImage[] = [
  { id: "zuma-rock", url: "pool/zuma-rock.jpg", alt: "A huge single dome-shaped rock rising out of flat green countryside", subject: "Zuma Rock, Niger State, near Abuja", topics: [...NIGERIA, "zuma", "abuja", "niger state"] },
  { id: "nigeria-flag", url: "pool/nigeria-flag.jpg", alt: "A flag of three vertical bands: green, white, green", subject: "The flag of Nigeria", topics: [...NIGERIA] },
  { id: "nigeria-outline", url: "pool/nigeria-outline.jpg", alt: "The borders of a West African country, roughly square with a southern coastline", subject: "The outline map of Nigeria", topics: [...NIGERIA] },
  { id: "national-theatre", url: "pool/national-theatre.jpg", alt: "A large round building with a sloping roof shaped like a military cap", subject: "The National Theatre, Iganmu, Lagos", topics: [...NIGERIA, "lagos", "national theatre", "iganmu"] },
  { id: "aso-rock", url: "pool/aso-rock.jpg", alt: "A broad granite outcrop rising behind government buildings", subject: "Aso Rock, Abuja", topics: [...NIGERIA, "aso rock", "abuja"] },
  { id: "olumo-rock", url: "pool/olumo-rock.jpg", alt: "A rocky outcrop with stairs and viewing platforms built into its side", subject: "Olumo Rock, Abeokuta", topics: [...NIGERIA, "olumo", "abeokuta", "ogun"] },
  { id: "lekki-ikoyi", url: "pool/lekki-ikoyi.jpg", alt: "A white cable-stayed bridge over a lagoon at dusk", subject: "The Lekki-Ikoyi Link Bridge, Lagos", topics: [...NIGERIA, "lagos", "lekki", "ikoyi"] },
];

export const poolImage = (id: string): PoolImage | undefined => IMAGE_POOL.find((i) => i.id === id);

/** The pool images that fit a set: all of them for a Geography set, else those whose topic words the brief uses. */
export function imagesFor(spec: Pick<GenerationSpec, "topic" | "categoryTag">, pool: PoolImage[] = IMAGE_POOL): PoolImage[] {
  if (POOL_CATEGORIES.includes(spec.categoryTag)) return pool;
  const brief = spec.topic.toLowerCase();
  return pool.filter((i) => i.topics.some((t) => new RegExp(`\\b${t}`).test(brief)));
}
