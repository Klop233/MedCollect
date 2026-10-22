export type Medicine = { id: string; genericName: string; totalGrams: string; boxCount: number; pendingCount: number; level: number; nextThreshold: string | null; progress: number; updatedAt: string; tags?: string[]; manufacturers?: string[]; hasCover?: boolean; coverUpdatedAt?: string | null };
export type Box = { id: string; medicineId: string; traceCode: string; genericName: string; manufacturer: string | null; specification: string | null; batchNumber: string | null; expiresAt: string | null; notes: string | null; massGrams: string | null; massBasis: string; source: 'manual' | 'api'; createdAt: string; updatedAt: string };
export type Candidate = { genericName: string; manufacturer?: string; specification?: string; batchNumber?: string; expiresAt?: string; suggestedMass?: { value: string; unit: 'g' | 'mg' | 'ug'; quantity: string; basis: string } };
export type Lookup = { status: 'found' | 'unconfigured' | 'forbidden' | 'not_found' | 'unsupported' | 'failed'; message: string; candidate?: Candidate };
export type Summary = { medicineCount: number; boxCount: number; pendingCount: number };
export type Album = { medicines: Medicine[]; summary: Summary };

// Keep the display milestones and server progression on the same product configuration.
export { THRESHOLDS as thresholds } from '@/lib/mass';
export const levelNames = ['初遇', '微光', '萌芽', '积累', '珍藏', '典藏'];

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(options?.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.assign('/sign-in');
    throw new Error('请先登录后继续');
  }
  if (!response.ok) throw new Error(body.error || '暂时无法完成操作，请稍后重试');
  return body as T;
}

export function dateLabel(value?: string | null) {
  return value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '未填写';
}
