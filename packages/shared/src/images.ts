/**
 * Images people keep (a brand's logo now): uploaded straight to object storage with a presigned PUT, never through
 * the API, then attached by their key. Each purpose sets its size cap; its key says what it's for and whose it is,
 * so the API can tell a key was made for this attach. Objects are private: views carry a short-lived read URL.
 */
import { z } from "zod";

export const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];
/** What an upload is for. Adding one (an avatar, a party cover) is an entry here and in the API's purpose registry. */
export const IMAGE_PURPOSES = ["brand_logo"] as const;
export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];
export const IMAGE_MAX_BYTES: Record<ImagePurpose, number> = { brand_logo: 1_000_000 };
/** How long an upload URL works, and how long a view's read URL does. */
export const IMAGE_UPLOAD_URL_SECONDS = 5 * 60;
export const IMAGE_READ_URL_SECONDS = 6 * 60 * 60;

export const IMAGE_EXTENSIONS: Record<ImageContentType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** images/<purpose>/<owner id>/<image id>.<ext> */
export const IMAGE_KEY_RE = new RegExp(`^images/(${IMAGE_PURPOSES.join("|")})/(${UUID})/${UUID}\\.(png|jpg|webp)$`);
export const imageKey = (purpose: ImagePurpose, ownerId: string, imageId: string, contentType: ImageContentType) =>
  `images/${purpose}/${ownerId}/${imageId}.${IMAGE_EXTENSIONS[contentType]}`;
/** The purpose and owner a key was made for, or null for anything that isn't an image key. */
export function parseImageKey(key: string): { purpose: ImagePurpose; ownerId: string; contentType: ImageContentType } | null {
  const m = IMAGE_KEY_RE.exec(key);
  if (!m) return null;
  const contentType = IMAGE_CONTENT_TYPES.find((t) => IMAGE_EXTENSIONS[t] === m[3])!;
  return { purpose: m[1] as ImagePurpose, ownerId: m[2], contentType };
}
export const imageKeySchema = z.string().regex(IMAGE_KEY_RE, "an uploaded image's key");

/** POST /images/uploads: ask for an upload URL. A brand's logo is asked for acting as the brand (x-act-as). */
export const imageUploadRequestSchema = z.object({
  purpose: z.enum(IMAGE_PURPOSES),
  contentType: z.enum(IMAGE_CONTENT_TYPES),
  bytes: z.number().int().min(1),
});
export type ImageUploadRequest = z.infer<typeof imageUploadRequestSchema>;
/** PUT the bytes to `upload.url` with exactly `upload.headers`, then attach `key` (e.g. PATCH /brands/:id { logoKey }). */
export const imageUploadResponseSchema = z.object({
  key: z.string(),
  upload: z.object({ url: z.string(), method: z.literal("PUT"), headers: z.record(z.string()), expiresAt: z.string().datetime() }),
});
export type ImageUploadResponse = z.infer<typeof imageUploadResponseSchema>;

/** 422: bigger than the purpose allows (asked for, or what arrived). */
export const IMAGE_TOO_LARGE = "image_too_large";
/** 422: nothing was uploaded under the key yet. */
export const IMAGE_NOT_UPLOADED = "image_not_uploaded";
/** 422: the bytes aren't the image type the key says (it's deleted). */
export const IMAGE_NOT_AN_IMAGE = "image_not_an_image";
/** 403: a key made for another purpose or another owner. */
export const IMAGE_NOT_YOURS = "image_not_yours";

/** Whether the first bytes are the type's signature (PNG, JPEG, WebP), so a key can't carry something else. */
export function looksLike(contentType: ImageContentType, head: Uint8Array): boolean {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (contentType === "image/png") return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contentType === "image/jpeg") return at(0, [0xff, 0xd8, 0xff]);
  return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
}
