import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import type { HistoryMessage } from "../conversation/history.js";
import {
  isChannelId,
  type ChannelId,
  type Contact,
  type Delivery,
  type InboundMessage,
  type Lead,
  type Reply,
  type StoredEvent,
} from "../domain.js";
import type { BeginEventResult, HelloStore, HelloTx } from "../store.js";
import * as schema from "./schema.js";
import { contacts, leads, messages, processedEvents } from "./schema.js";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function database(client: Pool | PoolClient): Database {
  return drizzle(client, { schema });
}

class PgTx implements HelloTx {
  constructor(private readonly tx: Tx) {}

  async beginEvent(
    eventId: string,
    channel: ChannelId,
    inbound?: InboundMessage,
  ): Promise<BeginEventResult> {
    const inserted = await this.tx
      .insert(processedEvents)
      .values({
        eventId,
        channel,
        status: "processing",
        deliveries: [],
        payload: inbound ?? null,
      })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    if (inserted.length > 0) return { status: "new" };

    const existing = await this.tx
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId));
    const row = existing[0];
    if (!row) throw new Error(`processed event ${eventId} disappeared during claim`);
    return { status: "existing", event: mapEvent(row) };
  }

  async saveEventDeliveries(eventId: string, deliveries: Delivery[]): Promise<void> {
    await this.tx
      .update(processedEvents)
      .set({ deliveries })
      .where(eq(processedEvents.eventId, eventId));
  }

  async getContact(phone: string): Promise<Contact | null> {
    const rows = await this.tx.select().from(contacts).where(eq(contacts.phone, phone));
    const row = rows[0];
    return row ? mapContact(row) : null;
  }

  async saveContact(contact: Contact): Promise<void> {
    const values = {
      phone: contact.phone,
      channel: contact.channel,
      humanTakeover: contact.humanTakeover,
      lastInboundAt: contact.lastInboundAt ? new Date(contact.lastInboundAt) : null,
    };
    await this.tx
      .insert(contacts)
      .values(values)
      .onConflictDoUpdate({
        target: contacts.phone,
        set: {
          channel: values.channel,
          humanTakeover: values.humanTakeover,
          lastInboundAt: values.lastInboundAt,
          updatedAt: new Date(),
        },
      });
  }

  async getLead(phone: string): Promise<Lead | null> {
    const rows = await this.tx.select().from(leads).where(eq(leads.phone, phone));
    const row = rows[0];
    return row ? mapLead(row) : null;
  }

  async saveLead(lead: Lead): Promise<void> {
    const values = {
      phone: lead.phone,
      name: lead.name,
      businessType: lead.businessType,
      need: lead.need,
      hasWhatsappBusinessNumber: lead.hasWhatsappBusinessNumber,
      notes: lead.notes,
    };
    await this.tx
      .insert(leads)
      .values(values)
      .onConflictDoUpdate({
        target: leads.phone,
        set: { ...values, updatedAt: new Date() },
      });
  }

  async listMessages(phone: string, limit: number): Promise<HistoryMessage[]> {
    if (limit < 1) return [];
    const rows = await this.tx
      .select({ role: messages.role, parts: messages.parts })
      .from(messages)
      .where(eq(messages.phone, phone))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    return rows.reverse().map(mapMessage);
  }

  async hasMessages(phone: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.phone, phone))
      .limit(1);
    return rows.length > 0;
  }

  async appendMessages(phone: string, history: HistoryMessage[]): Promise<void> {
    if (history.length === 0) return;
    await this.tx.insert(messages).values(
      history.map((message) => {
        if (message.role !== "user" && message.role !== "model") {
          throw new Error(`unexpected message role ${message.role}`);
        }
        if (!Array.isArray(message.parts)) throw new Error("message parts must be an array");
        return { phone, role: message.role, parts: message.parts };
      }),
    );
  }

  async clearMessages(phone: string): Promise<void> {
    await this.tx.delete(messages).where(eq(messages.phone, phone));
  }
}

const turnConnection = new AsyncLocalStorage<PoolClient>();

export function createPgStore(pool: Pool): HelloStore {
  return {
    async lock(phone, fn) {
      const client = await pool.connect();
      const key = `contact:${phone}`;
      const db = database(client);
      try {
        await db.execute(sql`select pg_advisory_lock(hashtext(${key})::bigint)`);
        return await turnConnection.run(client, fn);
      } finally {
        try {
          await db.execute(sql`select pg_advisory_unlock(hashtext(${key})::bigint)`);
        } finally {
          client.release();
        }
      }
    },
    async transact(fn) {
      const bound = turnConnection.getStore();
      if (bound) return database(bound).transaction((tx) => fn(new PgTx(tx)));
      const client = await pool.connect();
      try {
        return await database(client).transaction((tx) => fn(new PgTx(tx)));
      } finally {
        client.release();
      }
    },
    async markEventProcessed(eventId) {
      const db = database(turnConnection.getStore() ?? pool);
      await db
        .update(processedEvents)
        .set({ status: "processed", processedAt: new Date() })
        .where(eq(processedEvents.eventId, eventId));
    },
    async listInterrupted() {
      const rows = await database(pool)
        .select({ payload: processedEvents.payload })
        .from(processedEvents)
        .where(and(eq(processedEvents.status, "processing"), isNotNull(processedEvents.payload)))
        .orderBy(asc(processedEvents.createdAt));
      const found: InboundMessage[] = [];
      for (const row of rows) {
        const message = inboundFromPayload(row.payload);
        if (message) found.push(message);
      }
      return found;
    },
    async ping() {
      await database(pool).execute(sql`select 1`);
    },
  };
}

/** Reads the JSON saved on `processed_events.payload`. */
export function inboundFromPayload(value: unknown): InboundMessage | null {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed)) return null;
  if (typeof parsed.eventId !== "string" || typeof parsed.channelUserId !== "string") return null;
  if (typeof parsed.channel !== "string" || !isChannelId(parsed.channel)) return null;
  if (parsed.phone !== null && typeof parsed.phone !== "string") return null;
  if (parsed.text !== null && typeof parsed.text !== "string") return null;
  if (parsed.buttonId !== null && typeof parsed.buttonId !== "string") return null;
  return {
    channel: parsed.channel,
    eventId: parsed.eventId,
    channelUserId: parsed.channelUserId,
    phone: parsed.phone ?? null,
    text: parsed.text ?? null,
    buttonId: parsed.buttonId ?? null,
  };
}

function mapContact(row: typeof contacts.$inferSelect): Contact {
  if (!isChannelId(row.channel)) throw new Error(`unexpected channel ${row.channel}`);
  return {
    phone: row.phone,
    channel: row.channel,
    humanTakeover: row.humanTakeover,
    lastInboundAt: row.lastInboundAt ? row.lastInboundAt.toISOString() : null,
  };
}

function mapMessage(row: { role: string; parts: unknown }): HistoryMessage {
  if (row.role !== "user" && row.role !== "model") {
    throw new Error(`unexpected message role ${row.role}`);
  }
  const parts = typeof row.parts === "string" ? parseJson(row.parts) : row.parts;
  if (!Array.isArray(parts)) throw new Error("message parts were not a JSON array");
  return { role: row.role, parts };
}

function mapLead(row: typeof leads.$inferSelect): Lead {
  return {
    phone: row.phone,
    name: row.name,
    businessType: row.businessType,
    need: row.need,
    hasWhatsappBusinessNumber: row.hasWhatsappBusinessNumber,
    notes: row.notes,
  };
}

function mapEvent(row: typeof processedEvents.$inferSelect): StoredEvent {
  if (!isChannelId(row.channel)) throw new Error(`unexpected channel ${row.channel}`);
  if (row.status !== "processing" && row.status !== "processed") {
    throw new Error(`unexpected event status ${row.status}`);
  }
  return {
    eventId: row.eventId,
    channel: row.channel,
    status: row.status,
    deliveries: parseDeliveries(row.deliveries),
  };
}

function parseDeliveries(value: unknown): Delivery[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  const deliveries: Delivery[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.channel !== "string" || !isChannelId(item.channel)) {
      continue;
    }
    if (typeof item.to !== "string") continue;
    const reply = parseReply(item.reply);
    if (!reply) continue;
    deliveries.push({ channel: item.channel, to: item.to, reply });
  }
  return deliveries;
}

function parseReply(value: unknown): Reply | null {
  if (!isRecord(value) || (value.kind !== "text" && value.kind !== "template")) return null;
  if (value.kind === "text" && typeof value.body === "string") {
    return { kind: "text", body: value.body };
  }
  if (
    value.kind === "template" &&
    typeof value.templateName === "string" &&
    typeof value.language === "string"
  ) {
    const bodyParams = Array.isArray(value.bodyParams)
      ? value.bodyParams.filter((param): param is string => typeof param === "string")
      : undefined;
    return {
      kind: "template",
      templateName: value.templateName,
      language: value.language,
      ...(bodyParams && bodyParams.length > 0 ? { bodyParams } : {}),
    };
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
