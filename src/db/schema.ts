import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Delivery, InboundMessage } from "../domain.js";

export const contacts = pgTable(
  "contacts",
  {
    phone: text("phone").primaryKey(),
    channel: text("channel").notNull(),
    humanTakeover: boolean("human_takeover").notNull().default(false),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("contacts_phone_digits", sql`${table.phone} ~ '^[0-9]{8,15}$'`),
    check("contacts_channel_whatsapp", sql`${table.channel} in ('whatsapp')`),
  ],
);

export const leads = pgTable(
  "leads",
  {
    phone: text("phone")
      .primaryKey()
      .references(() => contacts.phone, { onDelete: "cascade" }),
    name: text("name"),
    businessType: text("business_type"),
    need: text("need"),
    hasWhatsappBusinessNumber: boolean("has_whatsapp_business_number"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const processedEvents = pgTable(
  "processed_events",
  {
    eventId: text("event_id").primaryKey(),
    channel: text("channel").notNull(),
    status: text("status").notNull(),
    deliveries: jsonb("deliveries").$type<Delivery[]>().notNull().default([]),
    payload: jsonb("payload").$type<InboundMessage | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    check("processed_events_channel_whatsapp", sql`${table.channel} in ('whatsapp')`),
    check("processed_events_status", sql`${table.status} in ('processing', 'processed')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    phone: text("phone")
      .notNull()
      .references(() => contacts.phone, { onDelete: "cascade" }),
    role: text("role").notNull(),
    parts: jsonb("parts").$type<unknown[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_phone_created_at_idx").on(table.phone, table.createdAt, table.id),
    check("messages_role", sql`${table.role} in ('user', 'model')`),
    check("messages_parts_array", sql`jsonb_typeof(${table.parts}) = 'array'`),
  ],
);
