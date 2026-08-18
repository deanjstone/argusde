import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_LIMITS,
  SUPPORTED_IMAGE_MIME_TYPES,
  base64ByteLength,
  refuseAttachment,
  refuseAttachmentSet,
  refuseForCapability,
} from "./attachments.js";

/**
 * The one place both ends agree on what is attachable (spec #93 phase 7,
 * argusde#119). The client uses these rules to refuse at attach time so the
 * user learns before composing a message around an image that was never going
 * to arrive; the server uses the same rules as the authoritative check,
 * because a client can be stale. Story 38 forbids a silent drop either way,
 * so every refusal here has to carry a reason a person can act on.
 */
describe("attachment rules", () => {
  describe("refuseAttachment", () => {
    it("accepts every image type the agent side supports", () => {
      for (const mimeType of SUPPORTED_IMAGE_MIME_TYPES) {
        expect(refuseAttachment({ mimeType, byteLength: 1024 }, { acceptsImages: true })).toBeUndefined();
      }
    });

    it("refuses a type that is not an image, naming it", () => {
      const reason = refuseAttachment({ mimeType: "application/pdf", byteLength: 1024 }, { acceptsImages: true });
      expect(reason).toBeDefined();
      expect(reason).toContain("application/pdf");
    });

    it("refuses an image format outside the supported set, naming it", () => {
      const reason = refuseAttachment({ mimeType: "image/tiff", byteLength: 1024 }, { acceptsImages: true });
      expect(reason).toBeDefined();
      expect(reason).toContain("image/tiff");
    });

    it("refuses any image when the connected agent never advertised image support", () => {
      const reason = refuseAttachment({ mimeType: "image/png", byteLength: 1024 }, { acceptsImages: false });
      expect(reason).toBeDefined();
      // The reason has to be about the agent, not about the file — the same
      // PNG is perfectly fine against an agent that does accept images.
      expect(reason).toMatch(/agent/i);
    });

    it("refuses an image over the per-image cap, naming the cap", () => {
      const reason = refuseAttachment(
        { mimeType: "image/png", byteLength: ATTACHMENT_LIMITS.maxBytesPerImage + 1 },
        { acceptsImages: true },
      );
      expect(reason).toBeDefined();
      expect(reason).toMatch(/1 MB|1 MiB/i);
    });

    it("accepts an image exactly at the cap — the boundary is inclusive", () => {
      expect(
        refuseAttachment({ mimeType: "image/png", byteLength: ATTACHMENT_LIMITS.maxBytesPerImage }, { acceptsImages: true }),
      ).toBeUndefined();
    });

    it("refuses an empty image rather than sending a zero-byte block", () => {
      expect(refuseAttachment({ mimeType: "image/png", byteLength: 0 }, { acceptsImages: true })).toBeDefined();
    });
  });

  describe("refuseForCapability", () => {
    it("passes when the agent advertised images", () => {
      expect(refuseForCapability({ acceptsImages: true })).toBeUndefined();
    });

    it("refuses when it did not, without needing a file to look at", () => {
      expect(refuseForCapability({ acceptsImages: false })).toMatch(/agent/i);
    });
  });

  describe("refuseAttachmentSet", () => {
    const image = { mimeType: "image/png", byteLength: 1024 };

    it("accepts a set within every limit", () => {
      expect(refuseAttachmentSet([image, image], { acceptsImages: true })).toBeUndefined();
    });

    it("accepts no attachments at all — a plain text message is not an attachment problem", () => {
      expect(refuseAttachmentSet([], { acceptsImages: false })).toBeUndefined();
    });

    it("refuses more images than one message may carry, naming the limit", () => {
      const tooMany = Array.from({ length: ATTACHMENT_LIMITS.maxImagesPerMessage + 1 }, () => image);
      const reason = refuseAttachmentSet(tooMany, { acceptsImages: true });
      expect(reason).toBeDefined();
      expect(reason).toContain(String(ATTACHMENT_LIMITS.maxImagesPerMessage));
    });

    it("accepts exactly the maximum number of images", () => {
      const atLimit = Array.from({ length: ATTACHMENT_LIMITS.maxImagesPerMessage }, () => image);
      expect(refuseAttachmentSet(atLimit, { acceptsImages: true })).toBeUndefined();
    });

    it("reports the first individually-bad attachment, so a mixed set is not blamed on its size", () => {
      const reason = refuseAttachmentSet([image, { mimeType: "text/csv", byteLength: 10 }], { acceptsImages: true });
      expect(reason).toContain("text/csv");
    });
  });

  describe("base64ByteLength", () => {
    it("measures the decoded size without decoding the payload", () => {
      // Three source bytes encode to exactly four base64 characters with no
      // padding — the case where a naive length*3/4 happens to be right.
      expect(base64ByteLength("YWJj")).toBe(3);
    });

    it("accounts for one padding character", () => {
      expect(base64ByteLength("YWJjZA==")).toBe(4);
    });

    it("accounts for two padding characters", () => {
      expect(base64ByteLength("YWJjZGU=")).toBe(5);
    });

    it("is zero for an empty payload", () => {
      expect(base64ByteLength("")).toBe(0);
    });

    it("agrees with an actual decode across a range of lengths", () => {
      for (let length = 1; length <= 32; length++) {
        const encoded = Buffer.from("x".repeat(length)).toString("base64");
        expect(base64ByteLength(encoded)).toBe(length);
      }
    });
  });
});
