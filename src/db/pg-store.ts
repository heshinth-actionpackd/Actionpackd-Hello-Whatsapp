import type { Pool, PoolClient } from "pg";
import {
  isChannelId,
  type ChannelId,
  type Contact,
  type Delivery,
  type Lead,
  type Reply,
  type StoredEvent,
} from "../domain.js";
import type { BeginEventResult, HelloStore, HelloTx } from "../store.js";

interface ContactRow {
  phone: string;
  channel: string;
  mistral_conversation_id: string | null;
  human_takeover: boolean;
  last_inbound_at: Date | null;
}

interface LeadRow {
  phone: string;
  name: string | null;
  business_type: string | null;
  need: string | null;
  has_whatsapp_business_number: boolean | null;
  notes: string | null;
}

interface EventRow {
  event_id: string;
  channel: string;
  status: string;
  deliveries: unknown;
}

class PgTx implements HelloTx {
  constructor(private readonly client: PoolClient) {}

  async beginEvent(eventId: string, channel: ChannelId): Promise<BeginEventResult> {
    const inserted = await this.client.query<{ event_id: string }>(
      `INSERT INTO processed_events (event_id, channel, status, deliveries)
       VALUES ($1, $2, 'processing', '[]'::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, channel],
    );
    if ((inserted.rowCount ?? 0) > 0) return { status: "new" };

    const existing = await this.client.query<EventRow>(
      `SELECT event_id, channel, status, deliveries
       FROM processed_events
       WHERE event_id = $1`,
      [eventId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error(`processed event ${eventId} disappeared during claim`);
    }
    return { status: "existing", event: mapEvent(row) };
  }

  async saveEventDeliveries(eventId: string, deliveries: Delivery[]): Promise<void> {
    await this.client.query(
      `UPDATE processed_events SET deliveries = $2::jsonb WHERE event_id = $1`,
      [eventId, JSON.stringify(deliveries)],
    );
  }

  async getContact(phone: string): Promise<Contact | null> {
    const result = await this.client.query<ContactRow>(
      `SELECT phone, channel, mistral_conversation_id, human_takeover, last_inbound_at
       FROM contacts
       WHERE phone = $1`,
      [phone],
    );
    const row = result.rows[0];
    return row ? mapContact(row) : null;
  }

  async saveContact(contact: Contact): Promise<void> {
    await this.client.query(
      `INSERT INTO contacts (
         phone, channel, mistral_conversation_id, human_takeover, last_inbound_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone) DO UPDATE SET
         channel = EXCLUDED.channel,
         mistral_conversation_id = EXCLUDED.mistral_conversation_id,
         human_takeover = EXCLUDED.human_takeover,
         last_inbound_at = EXCLUDED.last_inbound_at`,
      [
        contact.phone,
        contact.channel,
        contact.mistralConversationId,
        contact.humanTakeover,
        contact.lastInboundAt,
      ],
    );
  }

  async getLead(phone: string): Promise<Lead | null> {
    const result = await this.client.query<LeadRow>(
      `SELECT phone, name, business_type, need, has_whatsapp_business_number, notes
       FROM leads
       WHERE phone = $1`,
      [phone],
    );
    const row = result.rows[0];
    return row ? mapLead(row) : null;
  }

  async saveLead(lead: Lead): Promise<void> {
    await this.client.query(
      `INSERT INTO leads (
         phone, name, business_type, need, has_whatsapp_business_number, notes
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         business_type = EXCLUDED.business_type,
         need = EXCLUDED.need,
         has_whatsapp_business_number = EXCLUDED.has_whatsapp_business_number,
         notes = EXCLUDED.notes`,
      [
        lead.phone,
        lead.name,
        lead.businessType,
        lead.need,
        lead.hasWhatsappBusinessNumber,
        lead.notes,
      ],
    );
  }
}

export function createPgStore(pool: Pool): HelloStore {
  return {
    async lock(phone, fn) {
      const client = await pool.connect();
      const key = `contact:${phone}`;
      try {
        await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [key]);
        return await fn();
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]);
        } finally {
          client.release();
        }
      }
    },
    async transact(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn(new PgTx(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async markEventProcessed(eventId) {
      await pool.query(
        `UPDATE processed_events
         SET status = 'processed', processed_at = now()
         WHERE event_id = $1`,
        [eventId],
      );
    },
    async ping() {
      await pool.query("SELECT 1");
    },
  };
}

function mapContact(row: ContactRow): Contact {
  if (!isChannelId(row.channel)) throw new Error(`unexpected channel ${row.channel}`);
  return {
    phone: row.phone,
    channel: row.channel,
    mistralConversationId: row.mistral_conversation_id,
    humanTakeover: row.human_takeover,
    lastInboundAt: row.last_inbound_at ? row.last_inbound_at.toISOString() : null,
  };
}

function mapLead(row: LeadRow): Lead {
  return {
    phone: row.phone,
    name: row.name,
    businessType: row.business_type,
    need: row.need,
    hasWhatsappBusinessNumber: row.has_whatsapp_business_number,
    notes: row.notes,
  };
}

function mapEvent(row: EventRow): StoredEvent {
  if (!isChannelId(row.channel)) throw new Error(`unexpected channel ${row.channel}`);
  if (row.status !== "processing" && row.status !== "processed") {
    throw new Error(`unexpected event status ${row.status}`);
  }
  return {
    eventId: row.event_id,
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
