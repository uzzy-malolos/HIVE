import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import type { ProviderImageInput } from "./types.js";

export const MAX_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSION_MIME_TYPES = new Map<string, ProviderImageInput["mimeType"]>([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"],
]);
const SENSITIVE_SEGMENT = /^(?:\.git|\.hive|\.hivemind|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.env.*|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafePath(root: string, candidate: string): void {
  if (!inside(root, candidate)) throw new Error("Image must stay inside the workspace.");
  if (path.relative(root, candidate).split(/[\\/]/).some((part) => SENSITIVE_SEGMENT.test(part))) {
    throw new Error("Image attachments cannot read sensitive or internal paths.");
  }
}

function imageMimeType(bytes: Buffer): ProviderImageInput["mimeType"] | undefined {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return "image/jpeg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8 &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "image/webp";
  if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
      bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 0x3b) return "image/gif";
  return undefined;
}

/** Validate again at the provider boundary so callers cannot send URLs or unbounded arbitrary data. */
export function validateProviderImages(images: readonly ProviderImageInput[] | undefined): readonly ProviderImageInput[] {
  if (images === undefined) return [];
  if (!Array.isArray(images)) throw new Error("Image inputs must be an array.");
  let totalBytes = 0;
  for (const image of images) {
    if (!image || typeof image.data !== "string" || image.data.length === 0 ||
        image.data.length > Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 ||
        image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      throw new Error("Image input must contain bounded base64 image bytes.");
    }
    const bytes = Buffer.from(image.data, "base64");
    totalBytes += bytes.length;
    if (totalBytes > MAX_PROVIDER_IMAGE_BYTES) throw new Error("Image attachments exceed the 10 MiB request limit.");
    const actualMime = imageMimeType(bytes);
    if (bytes.toString("base64") !== image.data || actualMime === undefined || actualMime !== image.mimeType) {
      throw new Error("Image input does not match a supported PNG, JPEG, WebP, or GIF header.");
    }
  }
  return images;
}

/** Load an explicitly selected workspace image into memory for the current request only. */
export async function loadProviderImage(cwd: string, imagePath: string): Promise<ProviderImageInput> {
  if (typeof imagePath !== "string" || !imagePath.trim() || /[\x00-\x1f]/.test(imagePath) ||
      /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|file:|\\\\)/i.test(imagePath) ||
      imagePath.replace(/^[a-z]:[\\/]/i, "").includes(":")) {
    throw new Error("Image attachment requires a local workspace file path, not a URL.");
  }
  const root = path.resolve(cwd);
  const candidate = path.resolve(root, imagePath);
  assertSafePath(root, candidate);
  const expectedMime = EXTENSION_MIME_TYPES.get(path.extname(candidate).toLowerCase());
  if (!expectedMime) throw new Error("Image attachment must be a PNG, JPEG, WebP, or GIF file.");
  const rootReal = await fs.realpath(root);
  const real = await fs.realpath(candidate);
  assertSafePath(rootReal, real);
  // O_NOFOLLOW blocks a final symlink swap on platforms that support it.
  const file = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    const current = await fs.stat(real);
    assertSafePath(rootReal, await fs.realpath(candidate));
    if (stat.dev !== current.dev || stat.ino !== current.ino) throw new Error("Image changed while opening; attach it again.");
    if (!stat.isFile()) throw new Error("Image attachment must be a regular file.");
    if (stat.size === 0 || stat.size > MAX_PROVIDER_IMAGE_BYTES) throw new Error("Image attachment must be nonempty and at most 10 MiB.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error("Image changed while reading; attach it again.");
    const content = bytes.subarray(0, length);
    if (imageMimeType(content) !== expectedMime) throw new Error("Image file extension does not match a supported image header.");
    return { mimeType: expectedMime, data: content.toString("base64") };
  } finally {
    await file.close();
  }
}
