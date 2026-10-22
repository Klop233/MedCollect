import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 64 });
export const THRESHOLDS = ["0.01", "0.1", "1", "10", "100"] as const;
export type MassInput = {
  mode: "pending" | "total" | "unit";
  value?: string;
  unit?: "g" | "mg" | "ug";
  quantity?: string;
  basis?: string;
};

export function calculateMass(input: MassInput): { grams: string | null; basis: string } {
  if (input.mode === "pending") return { grams: null, basis: input.basis?.trim() || "质量待补全" };
  if (!input.value || !/^\d{1,12}(\.\d{1,9})?$/.test(input.value)) {
    throw new Error("请输入有效的正十进制质量，最多保留9位小数");
  }
  let grams = new D(input.value);
  if (!grams.gt(0)) throw new Error("质量必须大于0；未知质量请选择待补全");
  if (input.mode === "unit") {
    if (!input.unit || !["g", "mg", "ug"].includes(input.unit)) throw new Error("质量单位仅支持 g、mg、μg");
    if (!input.quantity || !/^\d{1,7}$/.test(input.quantity) || !new D(input.quantity).gt(0)) {
      throw new Error("包装数量必须为正整数");
    }
    grams = grams.div(input.unit === "mg" ? "1000" : input.unit === "ug" ? "1000000" : "1").mul(input.quantity);
  } else if (input.mode !== "total") {
    throw new Error("不支持的质量计算方式");
  }
  if (grams.gt("1000000")) throw new Error("单盒有效成分质量不能超过1000000g，请核对单位");
  const basis = input.basis?.trim() || (input.mode === "unit"
    ? `标注有效成分 ${input.value}${input.unit === "ug" ? "μg" : input.unit} × ${input.quantity} 个包装单位`
    : "");
  if (!basis) throw new Error("请填写总有效成分质量的计算依据");
  return { grams: grams.toFixed(), basis };
}

export function sumGrams(values: (string | null)[]): string {
  return values.reduce<Decimal>((sum, value) => value === null ? sum : sum.plus(value), new D(0)).toFixed();
}

export function getProgress(totalGrams: string) {
  const mass = new D(totalGrams);
  const level = THRESHOLDS.filter((threshold) => mass.gte(threshold)).length;
  const nextThreshold = THRESHOLDS[level] ?? null;
  const progress = nextThreshold === null ? 100 : Decimal.min(100, mass.div(nextThreshold).mul(100)).toNumber();
  return { level, nextThreshold, progress };
}
