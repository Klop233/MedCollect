/**
 * 本机查询的三条路，按顺序尝试：
 *
 *   1. APK 里的原生桥 window.MedCollectNative（请求由手机直接发给阿里）
 *   2. 桌面上的本机服务 http://127.0.0.1:8787（请求由这台电脑发出）
 *   3. 都不通就返回 null，调用方退回 Worker 的 /api/trace/lookup
 *
 * 前两条的共同点是：请求从用户自己的设备发出，不经过 Cloudflare、不需要密钥。
 * 地址是写死的常量，扫码内容只作为参数值，永远不会变成请求目标。
 */
import type { Candidate, Lookup } from '@/components/ui-types';

export const LOCAL_TRACE_ENDPOINT = 'http://127.0.0.1:8787/api/trace/medcollect';
const TIMEOUT_MS = 12_000;
/** 原生桥可能要等人拖完滑块，给得比 HTTP 宽裕得多。 */
const NATIVE_TIMEOUT_MS = 210_000;
const LIMITS = { genericName: 120, manufacturer: 200, specification: 500, batchNumber: 100 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** 本机服务返回的 MedCollect 字段名 → 界面使用的候选。形状不对返回 null。 */
export function mapLocalPayload(payload: unknown, code: string): Lookup | null {
  if (!isRecord(payload)) return null;
  if (payload.traceCode !== code) return { status: 'failed', message: '本机查询返回的追溯码和这次扫码不一致，请核对后手动补全。' };
  const genericName = text(payload.genericName, LIMITS.genericName);
  if (!genericName) return { status: 'failed', message: '本机查询没有给出药名，请手动补全。' };
  const candidate: Candidate = { genericName };
  const manufacturer = text(payload.manufacturer, LIMITS.manufacturer);
  const specification = text(payload.specification, LIMITS.specification);
  const batchNumber = text(payload.batchNumber, LIMITS.batchNumber);
  const expiresAt = text(payload.expiresAt, 10);
  if (manufacturer) candidate.manufacturer = manufacturer;
  if (specification) candidate.specification = specification;
  if (batchNumber) candidate.batchNumber = batchNumber;
  if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) candidate.expiresAt = expiresAt;
  // 质量一律留给用户按药盒填，本地服务也不推断。
  // 命中本机药品字典时给的是「这款药」的产品信息，批号和有效期必须按药盒核对。
  const message = payload.source === 'drug_dict'
    ? '本机药品字典命中：这款药以前查过，药名、规格和生产企业直接填好了。批号和有效期每一盒都不同，请照药盒补全。'
    : '找到候选药品，请按药盒确认药名、规格和有效成分质量。';
  return { status: 'found', message, candidate };
}

// --------------------------------------------------------------------------- APK 原生桥

interface NativeBridge {
  lookup(code: string, requestId: string): void;
}

type NativeWindow = Window & {
  MedCollectNative?: NativeBridge;
  __medcollectTrace?: (requestId: string, json: string) => void;
};

function nativeBridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as NativeWindow).MedCollectNative;
  return bridge && typeof bridge.lookup === 'function' ? bridge : null;
}

/** Android 原生返回的 {status, body|message} → 界面使用的查询结果。 */
export function mapNativePayload(raw: unknown, code: string): Lookup | null {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;
  const status = typeof payload.status === 'number' ? payload.status : 0;
  if (status === 200) return isRecord(payload.body) ? mapLocalPayload(payload.body, code) : null;
  if (status === 403) return null;                                  // 不是本站页面，当作没有这条路
  if (status === 404) {
    return { status: 'not_found', message: text(payload.message, 300) ?? '没有查到这盒药，可以手动补全。' };
  }
  if (status === 428) {
    return { status: 'failed', message: '需要人工验证：在弹出的页面里拖完滑块后点“重新查询”。' };
  }
  if (status === 400) {
    return { status: 'failed', message: text(payload.message, 300) ?? '追溯码格式不正确。' };
  }
  const message = text(payload.message, 300);
  return { status: 'failed', message: message ? `手机端查询失败：${message}` : '手机端查询失败，可以手动补全。' };
}

let requestSeq = 0;

/** 走 APK 原生桥。没有桥（普通浏览器）返回 null，调用方继续试后面的路。 */
export function lookupNatively(code: string, timeoutMs: number = NATIVE_TIMEOUT_MS): Promise<Lookup | null> {
  const bridge = nativeBridge();
  if (!bridge || !code) return Promise.resolve(null);
  return new Promise((resolve) => {
    const view = window as NativeWindow;
    const previous = view.__medcollectTrace;
    const requestId = `r${Date.now().toString(36)}${(requestSeq += 1).toString(36)}`;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(value: Lookup | null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (view.__medcollectTrace === handler) view.__medcollectTrace = previous;
      resolve(value);
    }

    const handler = (id: string, json: string) => {
      if (id !== requestId) {
        previous?.(id, json);
        return;
      }
      finish(mapNativePayload(json, code));
    };

    timer = setTimeout(() => finish({ status: 'failed', message: '手机端查询超时，可以手动补全。' }), timeoutMs);
    view.__medcollectTrace = handler;
    try {
      bridge.lookup(code, requestId);
    } catch {
      finish(null);
    }
  });
}

// --------------------------------------------------------------------------- HTTP 本机服务

/**
 * 问一次本机查询服务：先 APK 原生桥，再 127.0.0.1 的 trace-api。
 * 返回 null 表示「本机这条路都过不去」，调用方应回退到服务端查询。
 */
export async function lookupLocally(code: string, timeoutMs: number = TIMEOUT_MS): Promise<Lookup | null> {
  if (!code) return null;
  const native = await lookupNatively(code);
  if (native) return native;
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${LOCAL_TRACE_ENDPOINT}?code=${encodeURIComponent(code)}`, {
      method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit', signal: controller.signal,
    });
    if (response.status === 404) return { status: 'not_found', message: '本机查询服务没有这个追溯码的数据，你可以手动补全。' };
    if (response.status === 428) return { status: 'failed', message: '本机验证窗口已弹出：拖完滑块后点“重新查询”。' };
    if (response.status === 429) return { status: 'failed', message: '上游风控限流，稍后再试或手动补全。' };
    if (!response.ok) return null;
    return mapLocalPayload(await response.json().catch(() => null), code);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
