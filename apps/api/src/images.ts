/**
 * Image uploads (shared images.ts). Asking: each purpose says whose image it is and who may ask; the bytes then go
 * straight to object storage with a presigned PUT that pins the type and size. Attaching: the key must have been made
 * for this purpose and owner, be uploaded, fit the cap and start with the type's signature (anything else is deleted).
 * There's no image safety model yet: a brand's logo is looked at by an admin in verification review.
 */
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  ACT_AS_BRAND_REQUIRED, IMAGE_MAX_BYTES, IMAGE_NOT_AN_IMAGE, IMAGE_NOT_UPLOADED, IMAGE_NOT_YOURS, IMAGE_READ_URL_SECONDS, IMAGE_TOO_LARGE,
  IMAGE_UPLOAD_URL_SECONDS, imageKey, looksLike, parseImageKey, type ImagePurpose, type ImageUploadRequest, type ImageUploadResponse,
} from "@contestly/shared";
import { actor } from "./acting.js";
import { requireUser } from "./auth.js";
import { httpError } from "./httpError.js";
import { storage } from "./objectStore.js";
import { limit } from "./redis.js";

/** Uploads one person may ask for in an hour, across purposes. */
const UPLOADS_PER_HOUR = 30;

/** Whose image an upload is (the account its key is made for), checking the asker may set it. */
const OWNER_OF: Record<ImagePurpose, (req: FastifyRequest) => Promise<string>> = {
  /** A brand's logo: acting as the brand, with a role that changes its settings. */
  brand_logo: async (req) => {
    const { brand } = await actor(req, "settings");
    if (!brand) throw httpError(400, ACT_AS_BRAND_REQUIRED);
    return brand.account.id;
  },
};

export async function presignImageUpload(req: FastifyRequest, ask: ImageUploadRequest): Promise<ImageUploadResponse> {
  const ownerId = await OWNER_OF[ask.purpose](req);
  if (ask.bytes > IMAGE_MAX_BYTES[ask.purpose]) throw httpError(422, IMAGE_TOO_LARGE, { maxBytes: IMAGE_MAX_BYTES[ask.purpose] });
  await limit("image-upload", requireUser(req).id, UPLOADS_PER_HOUR, 3600);
  const key = imageKey(ask.purpose, ownerId, randomUUID(), ask.contentType);
  const upload = await storage().presignPut({ key, contentType: ask.contentType, contentLength: ask.bytes, expiresSeconds: IMAGE_UPLOAD_URL_SECONDS });
  return { key, upload };
}

/** The key is a finished upload of this purpose for this owner: 403 image_not_yours, 422 not uploaded, too large or not the type. */
export async function checkUploadedImage(key: string, purpose: ImagePurpose, ownerId: string): Promise<void> {
  const parsed = parseImageKey(key);
  if (!parsed || parsed.purpose !== purpose || parsed.ownerId !== ownerId) throw httpError(403, IMAGE_NOT_YOURS);
  const found = await storage().head(key);
  if (!found) throw httpError(422, IMAGE_NOT_UPLOADED);
  const tooLarge = found.bytes > IMAGE_MAX_BYTES[purpose];
  if (tooLarge || !looksLike(parsed.contentType, await storage().read(key))) {
    await storage().remove(key);
    throw httpError(422, tooLarge ? IMAGE_TOO_LARGE : IMAGE_NOT_AN_IMAGE);
  }
}

/**
 * Delete images nothing points at any more, after the change that let go of them has committed. A failure only
 * leaves an orphan in storage, so it's logged, not thrown: the request it follows has already saved.
 */
export async function removeImages(keys: string[], log: FastifyRequest["log"]): Promise<void> {
  await Promise.all(keys.map((key) => storage().remove(key).catch((err) => log.warn({ err, key }, "replaced image not deleted"))));
}

/** A view's read URL for an attached image, or null without one. */
export async function imageUrl(key: string | null): Promise<string | null> {
  return key ? (await storage().presignGet({ key, expiresSeconds: IMAGE_READ_URL_SECONDS })).url : null;
}
