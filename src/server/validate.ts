import { type EnhanceErrorCode, LIMITS } from '@/shared/enhance';

export type ImageFormat = 'jpeg' | 'png';

export type ValidationResult =
  | { ok: true; format: ImageFormat; width: number; height: number; contentType: string }
  | { ok: false; code: EnhanceErrorCode; message: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

export function detectFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  return null;
}

function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // Signature (8) + IHDR length (4) + "IHDR" (4), then width and height as big-endian uint32.
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Start-of-frame markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not. */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Fill bytes and standalone markers have no length field.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // End of image or start of scan before any frame.
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (isSofMarker(marker)) {
      if (offset + 9 > bytes.length) return null;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Validates an uploaded image before any AI provider is called.
 * See specs/image-enhancement: Input validation and Input pixel limit.
 */
export function validateImage(bytes: Uint8Array): ValidationResult {
  if (bytes.byteLength > LIMITS.maxUploadBytes) {
    return { ok: false, code: 'file_too_large', message: 'Images must be 20 MB or smaller.' };
  }
  const format = detectFormat(bytes);
  if (!format) {
    return { ok: false, code: 'unsupported_format', message: 'Only JPEG and PNG images are supported.' };
  }
  const size = format === 'png' ? readPngSize(bytes) : readJpegSize(bytes);
  if (!size || size.width === 0 || size.height === 0) {
    return { ok: false, code: 'unsupported_format', message: 'The image could not be read.' };
  }
  if (Math.min(size.width, size.height) < LIMITS.minSidePx) {
    return { ok: false, code: 'image_too_small', message: 'Images must be at least 64 pixels on each side.' };
  }
  if (size.width * size.height > LIMITS.maxInputPixels) {
    return { ok: false, code: 'image_too_large', message: 'Images must be 4 megapixels or smaller.' };
  }
  return {
    ok: true,
    format,
    width: size.width,
    height: size.height,
    contentType: format === 'png' ? 'image/png' : 'image/jpeg',
  };
}
