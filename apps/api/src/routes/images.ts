import type { FastifyInstance } from "fastify";
import { imageUploadRequestSchema, imageUploadResponseSchema } from "@contestly/shared";
import { presignImageUpload } from "../images.js";

export async function imagesRoutes(app: FastifyInstance) {
  /**
   * An upload URL for an image (a brand's logo: acting as the brand, with settings). PUT the bytes there with the
   * headers given, then attach the key where it goes (PATCH /brands/:id { logoKey }).
   */
  app.post("/images/uploads", { config: { actAs: "settings" } }, async (req) =>
    imageUploadResponseSchema.parse(await presignImageUpload(req, imageUploadRequestSchema.parse(req.body))));
}
