import type { MassInput } from "./mass";

export type MedicineSummary = {
  id: string;
  genericName: string;
  totalGrams: string;
  boxCount: number;
  pendingCount: number;
  level: number;
  nextThreshold: string | null;
  progress: number;
  updatedAt: string;
  tags?: string[];
  manufacturers?: string[];
  hasCover?: boolean;
  coverUpdatedAt?: string | null;
};
export type CollectionBox = {
  id: string;
  medicineId: string;
  traceCode: string;
  genericName: string;
  manufacturer: string;
  specification: string;
  batchNumber: string;
  expiresAt: string;
  notes: string;
  massGrams: string | null;
  massBasis: string;
  source: "manual" | "api";
  createdAt: string;
  updatedAt: string;
};
export type BoxInput = {
  traceCode: string;
  genericName: string;
  manufacturer?: string;
  specification?: string;
  batchNumber?: string;
  expiresAt?: string;
  notes?: string;
  mass: MassInput;
  source?: "manual" | "api";
  tags?: string[];
};
