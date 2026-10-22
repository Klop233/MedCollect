import { AppError } from "./collections";
import type { WorkerEnv } from "./worker-env";
const MAX_BYTES = 5 * 1024 * 1024;
function dimensions(width: number, height: number) { if (!width || !height || width > 4096 || height > 4096) throw new AppError("封面尺寸不能超过4096×4096，请先压缩图片"); }
function concat(parts: Uint8Array[]) { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) { result.set(p, offset); offset += p.length; } return result; }

/** Strip metadata on the server too; a direct API client must not preserve hidden EXIF. */
export function sanitizeCover(bytes: Uint8Array): { bytes: Uint8Array; type: string; extension: string } {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new AppError("封面图片不能超过5MB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 32 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
    const parts = [bytes.slice(0, 8)]; let pos = 8, header = false, data = false, end = false;
    while (pos + 12 <= bytes.length) {
      const length = view.getUint32(pos), type = String.fromCharCode(...bytes.slice(pos + 4, pos + 8));
      if (length > bytes.length - pos - 12) throw new AppError("PNG结构无效");
      if (type === "IHDR") { if (header || pos !== 8 || length !== 13) throw new AppError("PNG结构无效"); dimensions(view.getUint32(pos + 8), view.getUint32(pos + 12)); header = true; }
      if (type === "IDAT") data = true;
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)) parts.push(bytes.slice(pos, pos + length + 12));
      pos += length + 12;
      if (type === "IEND") { end = length === 0; break; }
    }
    if (!header || !data || !end) throw new AppError("PNG图片不完整");
    return { bytes: concat(parts), type: "image/png", extension: "png" };
  }
  if (bytes.length > 16 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    const parts = [bytes.slice(0, 2)]; let pos = 2, hasDimensions = false, scan = false;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 255) throw new AppError("JPEG结构无效");
      let markerIndex = pos + 1; while (bytes[markerIndex] === 255) markerIndex++;
      const marker = bytes[markerIndex], start = markerIndex + 1;
      if (marker === 218) { parts.push(bytes.slice(pos)); scan = true; break; }
      if (marker === 217 || start + 2 > bytes.length) break;
      const length = view.getUint16(start);
      if (length < 2 || start + length > bytes.length) throw new AppError("JPEG结构无效");
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { if (length < 8) throw new AppError("JPEG结构无效"); dimensions(view.getUint16(start + 5), view.getUint16(start + 3)); hasDimensions = true; }
      if (!(marker >= 224 && marker <= 239) && marker !== 254) parts.push(bytes.slice(pos, start + length));
      pos = start + length;
    }
    if (!hasDimensions || !scan) throw new AppError("JPEG图片不完整");
    return { bytes: concat(parts), type: "image/jpeg", extension: "jpg" };
  }
  throw new AppError("请上传JPEG或PNG图片，WebP等格式会由页面先转换；不接受SVG");
}

export function createCoverService(env: WorkerEnv) {
  async function owned(owner: string, id: string) {
    const row = await env.DB.prepare("SELECT cover_key FROM medicines WHERE owner_id=? AND id=?").bind(owner, id).first<{ cover_key: string | null }>();
    if (!row) throw new AppError("收藏不存在", 404);
    if (!env.COVERS) throw new AppError("封面存储未配置，请绑定私有R2存储桶", 503);
    return row;
  }
  async function get(owner: string, id: string) {
    const row = await owned(owner, id); if (!row.cover_key) throw new AppError("尚未设置封面", 404);
    const object = await env.COVERS!.get(row.cover_key); if (!object) throw new AppError("封面不存在", 404);
    return new Response(object.body as ReadableStream, { headers: { "Content-Type": object.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  }
  async function put(owner: string, id: string, bytes: Uint8Array) {
    const row = await owned(owner, id), image = sanitizeCover(bytes), key = `${owner}/${id}/${crypto.randomUUID()}.${image.extension}`;
    await env.COVERS!.put(key, image.bytes, { httpMetadata: { contentType: image.type } });
    try {
      const updated = await env.DB.prepare("UPDATE medicines SET cover_key=?,cover_updated_at=?,updated_at=? WHERE id=? AND owner_id=? AND cover_key IS ? RETURNING id").bind(key, new Date().toISOString(), new Date().toISOString(), id, owner, row.cover_key).first();
      if (!updated) throw new AppError("封面刚被更改，请刷新重试", 409);
    } catch (error) { await env.COVERS!.delete(key).catch(() => undefined); throw error; }
    if (row.cover_key) await env.COVERS!.delete(row.cover_key).catch(() => undefined);
    return { ok: true };
  }
  async function remove(owner: string, id: string) {
    const row = await owned(owner, id);
    const updated = await env.DB.prepare("UPDATE medicines SET cover_key=NULL,cover_updated_at=?,updated_at=? WHERE id=? AND owner_id=? AND cover_key IS ? RETURNING id").bind(new Date().toISOString(), new Date().toISOString(), id, owner, row.cover_key).first();
    if (!updated) throw new AppError("封面刚被更改，请刷新重试", 409);
    if (row.cover_key) await env.COVERS!.delete(row.cover_key).catch(() => undefined);
    return { ok: true };
  }
  return { get, put, remove };
}
