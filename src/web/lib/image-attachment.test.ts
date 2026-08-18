import { describe, it, expect } from "vitest";
import { ATTACHMENT_LIMITS } from "../../shared/attachments.js";
import { targetDimensions, needsReencoding } from "./image-attachment.js";

/**
 * The decisions the composer's encoder makes before touching a canvas (spec
 * #93 phase 7). Kept pure and tested here because the encode itself only
 * runs in a real browser — see test/web-smoke.test.ts for that half.
 */
describe("image attachment sizing", () => {
  describe("targetDimensions", () => {
    it("leaves an image already inside the bound untouched", () => {
      expect(targetDimensions(800, 600)).toEqual({ width: 800, height: 600 });
    });

    it("leaves an image exactly on the bound untouched", () => {
      const edge = ATTACHMENT_LIMITS.maxImageEdge;
      expect(targetDimensions(edge, edge)).toEqual({ width: edge, height: edge });
    });

    it("scales a wide image by its longest edge, preserving the aspect ratio", () => {
      const { width, height } = targetDimensions(4000, 2000);
      expect(width).toBe(ATTACHMENT_LIMITS.maxImageEdge);
      expect(height).toBe(Math.round(ATTACHMENT_LIMITS.maxImageEdge / 2));
    });

    it("scales a tall image by its longest edge too — a phone screenshot is portrait", () => {
      // 1080x2400 is a common phone screenshot: the *height* is what exceeds
      // the bound, and scaling on width would leave it oversized.
      const { width, height } = targetDimensions(1080, 2400);
      expect(height).toBe(ATTACHMENT_LIMITS.maxImageEdge);
      expect(width).toBeLessThan(1080);
      expect(width / height).toBeCloseTo(1080 / 2400, 2);
    });

    it("never rounds a dimension down to zero on an extreme aspect ratio", () => {
      const { width, height } = targetDimensions(10000, 1);
      expect(width).toBe(ATTACHMENT_LIMITS.maxImageEdge);
      expect(height).toBeGreaterThanOrEqual(1);
    });

    it("returns whole pixels — a canvas cannot be drawn at a fractional size", () => {
      const { width, height } = targetDimensions(3333, 1777);
      expect(Number.isInteger(width)).toBe(true);
      expect(Number.isInteger(height)).toBe(true);
    });
  });

  describe("needsReencoding", () => {
    const small = { width: 800, height: 600, byteLength: 100 * 1024, mimeType: "image/png" };

    it("passes through a small image of a supported type untouched", () => {
      expect(needsReencoding(small)).toBe(false);
    });

    it("re-encodes an image past the pixel bound, even when its bytes are small", () => {
      // A large but highly compressible screenshot: under the byte cap, over
      // the pixel bound. Sending it as-is would persist far more pixels than
      // the model will ever look at.
      expect(needsReencoding({ ...small, width: 3000, height: 1200 })).toBe(true);
    });

    it("re-encodes an image past the byte cap, even when its dimensions are fine", () => {
      expect(needsReencoding({ ...small, byteLength: ATTACHMENT_LIMITS.maxBytesPerImage + 1 })).toBe(true);
    });

    it("does not re-encode an image exactly at the byte cap", () => {
      expect(needsReencoding({ ...small, byteLength: ATTACHMENT_LIMITS.maxBytesPerImage })).toBe(false);
    });

    it("re-encodes a supported-but-unwanted source format so what is sent is what was measured", () => {
      // The browser will happily hand over an image/avif or image/heic from a
      // phone camera roll. Those are not in the supported set, so they have
      // to be converted rather than refused outright — refusing a camera-roll
      // photo is the one case story 33 is actually about.
      expect(needsReencoding({ ...small, mimeType: "image/heic" })).toBe(true);
      expect(needsReencoding({ ...small, mimeType: "image/avif" })).toBe(true);
    });
  });
});
