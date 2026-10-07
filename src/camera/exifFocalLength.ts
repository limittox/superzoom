/** Reads EXIF FocalLength (tag 0x920A) from JPEG bytes, to tell which lens took a photo. */

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_FOCAL_LENGTH = 0x920a;
const TYPE_RATIONAL = 5;

interface Tiff {
  view: DataView;
  /** Offset of the TIFF header within the view. */
  base: number;
  little: boolean;
}

/** Finds the value offset of `tag` in the IFD at `ifdOffset`, or null. */
function findEntry(tiff: Tiff, ifdOffset: number, tag: number): { type: number; valueOffset: number } | null {
  const { view, base, little } = tiff;
  const start = base + ifdOffset;
  if (start + 2 > view.byteLength) return null;
  const count = view.getUint16(start, little);
  for (let i = 0; i < count; i++) {
    const entry = start + 2 + i * 12;
    if (entry + 12 > view.byteLength) return null;
    if (view.getUint16(entry, little) === tag) {
      return { type: view.getUint16(entry + 2, little), valueOffset: entry + 8 };
    }
  }
  return null;
}

function readRational(tiff: Tiff, valueOffset: number): number | null {
  const { view, base, little } = tiff;
  // Rationals (8 bytes) don't fit in the entry, so the entry holds an offset to them.
  const at = base + view.getUint32(valueOffset, little);
  if (at + 8 > view.byteLength) return null;
  const numerator = view.getUint32(at, little);
  const denominator = view.getUint32(at + 4, little);
  return denominator === 0 ? null : numerator / denominator;
}

function focalLengthFromTiff(tiff: Tiff): number | null {
  const { view, base, little } = tiff;
  if (base + 8 > view.byteLength || view.getUint16(base + 2, little) !== 42) return null;
  const ifd0 = view.getUint32(base + 4, little);

  // FocalLength normally lives in the Exif sub-IFD; accept IFD0 too.
  const pointer = findEntry(tiff, ifd0, TAG_EXIF_IFD_POINTER);
  const exifIfd = pointer ? view.getUint32(pointer.valueOffset, little) : null;
  const entry =
    (exifIfd !== null ? findEntry(tiff, exifIfd, TAG_FOCAL_LENGTH) : null) ?? findEntry(tiff, ifd0, TAG_FOCAL_LENGTH);
  if (!entry || entry.type !== TYPE_RATIONAL) return null;
  return readRational(tiff, entry.valueOffset);
}

/** FocalLength in mm, or null when the JPEG has no readable EXIF focal length. */
export function readExifFocalLength(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  try {
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) return null;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda || marker === 0xd9) return null; // Image data starts; no EXIF before it.
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      const segment = offset + 4;
      const isExif =
        marker === 0xe1 &&
        segment + 6 <= view.byteLength &&
        String.fromCharCode(...bytes.subarray(segment, segment + 4)) === 'Exif' &&
        view.getUint16(segment + 4) === 0;
      if (isExif) {
        const base = segment + 6;
        if (base + 2 > view.byteLength) return null;
        const order = view.getUint16(base);
        if (order !== 0x4949 && order !== 0x4d4d) return null; // "II" little-endian / "MM" big-endian
        return focalLengthFromTiff({ view, base, little: order === 0x4949 });
      }
      offset += 2 + length;
    }
  } catch {
    // RangeError from a truncated or malformed file.
  }
  return null;
}
