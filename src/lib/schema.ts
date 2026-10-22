import { foreignKey, index, sqliteTable, text, uniqueIndex, integer } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
export * from "./auth-schema";

export const medicines = sqliteTable("medicines", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  genericName: text("generic_name").notNull(),
  nameKey: text("name_key").notNull(),
  tagsJson: text("tags_json").notNull().default("[]"),
  coverKey: text("cover_key"),
  coverUpdatedAt: text("cover_updated_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("medicines_owner_name").on(t.ownerId, t.nameKey), uniqueIndex("medicines_id_owner").on(t.id, t.ownerId)]);

export const boxes = sqliteTable("collection_boxes", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  medicineId: text("medicine_id").notNull(),
  traceCode: text("trace_code").notNull(),
  traceKey: text("trace_key").notNull(),
  manufacturer: text("manufacturer").notNull().default(""),
  specification: text("specification").notNull().default(""),
  batchNumber: text("batch_number").notNull().default(""),
  expiresAt: text("expires_at").notNull().default(""),
  notes: text("notes").notNull().default(""),
  massGrams: text("mass_grams"),
  massBasis: text("mass_basis").notNull(),
  // Keep the old stored label readable; public records normalize it to the generic API source.
  source: text("source", { enum: ["manual", "api", "alihealth"] }).notNull().default("manual"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("boxes_owner_trace").on(t.ownerId, t.traceKey),
  index("boxes_owner_medicine").on(t.ownerId, t.medicineId),
  foreignKey({ columns: [t.medicineId, t.ownerId], foreignColumns: [medicines.id, medicines.ownerId] }).onDelete("cascade"),
]);

export const requestLimits = sqliteTable("request_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull(),
});
