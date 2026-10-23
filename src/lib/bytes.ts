export function concatBytes(parts: readonly Uint8Array[]): ArrayBuffer {
  const result = new Uint8Array(new ArrayBuffer(parts.reduce((total, part) => total + part.byteLength, 0)));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result.buffer;
}
