import test from "node:test";
import assert from "node:assert/strict";
import { calculateMass, getProgress, sumGrams, type MassInput } from "../src/lib/mass";

// Contract: label strength × actual package count, never package count as achievement points.
// Regression path: parsing units or converting to binary Number before aggregation.
test("effective ingredient mass is normalized without floating point loss", () => {
  const cases: [MassInput, string][] = [
    [{ mode: "unit", value: "0.5", unit: "g", quantity: "20" }, "10"],
    [{ mode: "unit", value: "250", unit: "mg", quantity: "24" }, "6"],
    [{ mode: "unit", value: "0.25", unit: "ug", quantity: "30" }, "0.0000075"],
    [{ mode: "total", value: "0.01", basis: "包装标注有效成分总量" }, "0.01"],
  ];
  for (const [input, expected] of cases) assert.equal(calculateMass(input).grams, expected);
  assert.equal(sumGrams(["0.1", "0.2", null, "0.0000075"]), "0.3000075");
});

test("unknown mass stays pending; only known mass contributes to per-drug achievements", () => {
  assert.equal(calculateMass({ mode: "pending" }).grams, null);
  assert.equal(sumGrams([null, null]), "0");
  assert.equal(getProgress(sumGrams(["0.009", null])).level, 0);
  assert.equal(getProgress(sumGrams(["0.009", "0.001"])).level, 1);
  // A deleted/corrected record must be allowed to lower the active collection's level.
  assert.equal(getProgress(sumGrams(["0.009"])).level, 0);
});

test("invalid or unconvertible inputs cannot masquerade as effective mass", () => {
  const cases: MassInput[] = [
    { mode: "total", value: "0", basis: "unknown" },
    { mode: "total", value: "-1", basis: "bad" },
    { mode: "total", value: "NaN", basis: "bad" },
    { mode: "total", value: "1e9", basis: "bad" },
    { mode: "total", value: "1" },
    { mode: "unit", value: "1", unit: "g", quantity: "0" },
    { mode: "unit", value: "1", unit: "g", quantity: "1.5" },
    { mode: "unit", value: "1", unit: "ml" as "g", quantity: "2" },
  ];
  for (const input of cases) assert.throws(() => calculateMass(input));
});
