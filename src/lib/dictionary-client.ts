/**
 * 共享药品字典的浏览器端：先问服务器「这款药以前有人查过吗」，
 * 查到就省掉一次上游请求；反过来，真正查到一次之后也把它报上去。
 *
 * 两条路都不允许影响扫码本身：任何失败都当没发生。
 */
import type { Candidate, Lookup } from '@/components/ui-types';

const TIMEOUT_MS = 4_000;
const LIMITS = { genericName: 120, manufacturer: 200, specification: 500 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** 共享字典只有产品级信息，批号和有效期必须按药盒核对。 */
export async function lookupSharedDictionary(code: string): Promise<Lookup | null> {
  if (!code || typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`/api/dictionary?code=${encodeURIComponent(code)}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json' }, signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (!isRecord(payload) || payload.hit !== true || !isRecord(payload.product)) return null;
    const genericName = text(payload.product.genericName, LIMITS.genericName);
    if (!genericName) return null;
    const candidate: Candidate = { genericName };
    const manufacturer = text(payload.product.manufacturer, LIMITS.manufacturer);
    const specification = text(payload.product.specification, LIMITS.specification);
    if (manufacturer) candidate.manufacturer = manufacturer;
    if (specification) candidate.specification = specification;
    return {
      status: 'found',
      message: '共享字典命中：这款药以前查到过，药名、规格和生产企业直接填好了。批号和有效期每一盒都不同，请照药盒补全。',
      candidate,
      source: 'shared',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 真正查到一次之后上报；失败就算了，不能影响收藏。 */
export function reportSharedDictionary(code: string, candidate: Candidate): void {
  if (!code || typeof fetch !== 'function') return;
  const product = {
    genericName: candidate.genericName,
    specification: candidate.specification,
    manufacturer: candidate.manufacturer,
  };
  void fetch('/api/dictionary', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, product }),
  }).catch(() => undefined);
}
