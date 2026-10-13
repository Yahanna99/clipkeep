const MP4_EPOCH = 2082844800;
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "edts", "moof", "traf"]);
const STAMPED = new Set(["mvhd", "tkhd", "mdhd"]);

function atomType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

/** iOS Photos rejects mp4s whose creation time is still the 1904 epoch. */
export function stampMp4Times(input: Uint8Array, now = Date.now()): Uint8Array {
  if (input.length < 8) return input;
  const brand = atomType(input, 0);
  if (brand !== "ftyp" && brand !== "moov") return input;
  const bytes = input.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stamp = (Math.floor(now / 1000) + MP4_EPOCH) >>> 0;

  const walk = (start: number, end: number) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = atomType(bytes, offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const wide = view.getBigUint64(offset + 8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(wide);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) break;
      const payload = offset + header;
      const next = offset + size;
      if (STAMPED.has(type)) {
        const version = bytes[payload];
        if (version === 1 && payload + 20 <= next) {
          view.setBigUint64(payload + 4, BigInt(stamp));
          view.setBigUint64(payload + 12, BigInt(stamp));
        } else if (payload + 12 <= next) {
          view.setUint32(payload + 4, stamp);
          view.setUint32(payload + 8, stamp);
        }
      } else if (CONTAINERS.has(type)) {
        walk(payload, next);
      } else if (type === "meta" && payload + 4 <= next) {
        walk(payload + 4, next);
      }
      offset = next;
    }
  };

  walk(0, bytes.length);
  return bytes;
}
