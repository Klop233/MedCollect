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

/**
 * 共享药品字典：按药品标识码前缀只存「产品级」信息。
 *
 * 20 位追溯码 = 药品标识码 + 序列号，同款药的每一盒只有序列号不同，所以查到一次就能回答
 * 同款药的其他盒。批号、生产日期、有效期属于每一盒，永远不进这张表。
 * 同一前缀后来出现不同药品时置 ambiguous=1 并停止命中：宁可少缓存，也不给错药名。
 */
export const drugDictionary = sqliteTable("drug_dictionary", {
  prefix: text("prefix").primaryKey(),
  productJson: text("product_json").notNull(),
  // 药名|规格|企业 的归一化指纹，用来判断两次上报是不是同一款药
  fingerprint: text("fingerprint").notNull(),
  samples: integer("samples").notNull().default(1),
  ambiguous: integer("ambiguous").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
