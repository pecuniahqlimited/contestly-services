/**
 * The image pool picture questions are written about. Every image has alt text describing what it shows; a
 * generator may only use an image from here, so the engine never hot-links a web image. This is a code list
 * of the images we have until a licensed or generated pool exists (ADR 0016); picture rounds are therefore
 * limited to these subjects.
 */
export interface PoolImage {
  id: string;
  url: string;
  alt: string;
  /** What the picture is of, plainly: the fact a question about it rests on. */
  subject: string;
}

export const IMAGE_POOL: PoolImage[] = [
  { id: "zuma-rock", url: "pool/zuma-rock.jpg", alt: "A huge single dome-shaped rock rising out of flat green countryside", subject: "Zuma Rock, Niger State, near Abuja" },
  { id: "nigeria-flag", url: "pool/nigeria-flag.jpg", alt: "A flag of three vertical bands: green, white, green", subject: "The flag of Nigeria" },
  { id: "nigeria-outline", url: "pool/nigeria-outline.jpg", alt: "The borders of a West African country, roughly square with a southern coastline", subject: "The outline map of Nigeria" },
  { id: "national-theatre", url: "pool/national-theatre.jpg", alt: "A large round building with a sloping roof shaped like a military cap", subject: "The National Theatre, Iganmu, Lagos" },
  { id: "aso-rock", url: "pool/aso-rock.jpg", alt: "A broad granite outcrop rising behind government buildings", subject: "Aso Rock, Abuja" },
  { id: "olumo-rock", url: "pool/olumo-rock.jpg", alt: "A rocky outcrop with stairs and viewing platforms built into its side", subject: "Olumo Rock, Abeokuta" },
  { id: "lekki-ikoyi", url: "pool/lekki-ikoyi.jpg", alt: "A white cable-stayed bridge over a lagoon at dusk", subject: "The Lekki-Ikoyi Link Bridge, Lagos" },
];

export const poolImage = (id: string): PoolImage | undefined => IMAGE_POOL.find((i) => i.id === id);
