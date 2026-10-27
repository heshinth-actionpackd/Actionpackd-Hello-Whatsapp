import type { HistoryMessage } from "../src/conversation/history.js";
import type {
  ChannelId,
  Contact,
  Delivery,
  InboundMessage,
  Lead,
  Reply,
  StoredEvent,
} from "../src/domain.js";
import type { BeginEventResult, HelloStore, HelloTx } from "../src/store.js";

interface StoredMessage {
  phone: string;
  message: HistoryMessage;
}

interface Snapshot {
  contacts: Map<string, Contact>;
  leads: Map<string, Lead>;
  events: Map<string, StoredEvent>;
  payloads: Map<string, InboundMessage>;
  messages: StoredMessage[];
  contactWrites: number;
}

/** Test double with the same claim / rollback behavior as the Postgres store. */
export class MemoryStore implements HelloStore, HelloTx {
  contacts = new Map<string, Contact>();
  leads = new Map<string, Lead>();
  events = new Map<string, StoredEvent>();
  payloads = new Map<string, InboundMessage>();
  messages: StoredMessage[] = [];
  contactWrites = 0;
  /** When set, the next transact() throws once. Used to simulate a database outage. */
  failTransact = false;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pingImpl: () => Promise<void>;

  constructor(options?: { ping?: () => Promise<void> }) {
    this.pingImpl = options?.ping ?? (async () => undefined);
  }

  async ping(): Promise<void> {
    await this.pingImpl();
  }

  async lock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(phone) ?? Promise.resolve();
    const run = previous.then(
      () => fn(),
      () => fn(),
    );
    this.chains.set(
      phone,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async transact<T>(fn: (tx: HelloTx) => Promise<T>): Promise<T> {
    if (this.failTransact) {
      this.failTransact = false;
      throw new Error("db down");
    }
    const snapshot = this.snapshot();
    try {
      return await fn(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async beginEvent(
    eventId: string,
    channel: ChannelId,
    inbound?: InboundMessage,
  ): Promise<BeginEventResult> {
    const existing = this.events.get(eventId);
    if (existing) return { status: "existing", event: cloneEvent(existing) };
    this.events.set(eventId, { eventId, channel, status: "processing", deliveries: [] });
    if (inbound) this.payloads.set(eventId, { ...inbound });
    return { status: "new" };
  }

  async listInterrupted(): Promise<InboundMessage[]> {
    const found: InboundMessage[] = [];
    for (const [eventId, inbound] of this.payloads) {
      if (this.events.get(eventId)?.status === "processing") found.push({ ...inbound });
    }
    return found;
  }

  async saveEventDeliveries(eventId: string, deliveries: Delivery[]): Promise<void> {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`unknown event ${eventId}`);
    event.deliveries = deliveries.map(cloneDelivery);
    event.status = "processing";
  }

  async getContact(phone: string): Promise<Contact | null> {
    const contact = this.contacts.get(phone);
    return contact ? { ...contact } : null;
  }

  async saveContact(contact: Contact): Promise<void> {
    this.contactWrites += 1;
    this.contacts.set(contact.phone, { ...contact });
  }

  async getLead(phone: string): Promise<Lead | null> {
    const lead = this.leads.get(phone);
    return lead ? { ...lead } : null;
  }

  async saveLead(lead: Lead): Promise<void> {
    this.leads.set(lead.phone, { ...lead });
  }

  async listMessages(phone: string, limit: number): Promise<HistoryMessage[]> {
    if (limit < 1) return [];
    return this.messages
      .filter((row) => row.phone === phone)
      .slice(-limit)
      .map((row) => cloneMessage(row.message));
  }

  async hasMessages(phone: string): Promise<boolean> {
    return this.messages.some((row) => row.phone === phone);
  }

  async appendMessages(phone: string, messages: HistoryMessage[]): Promise<void> {
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "model") {
        throw new Error(`unexpected message role ${message.role}`);
      }
      if (!Array.isArray(message.parts)) throw new Error("message parts must be an array");
      this.messages.push({ phone, message: cloneMessage(message) });
    }
  }

  async clearMessages(phone: string): Promise<void> {
    this.messages = this.messages.filter((row) => row.phone !== phone);
  }

  async markEventProcessed(eventId: string): Promise<void> {
    const event = this.events.get(eventId);
    if (!event) return;
    event.status = "processed";
  }

  private snapshot(): Snapshot {
    return {
      contacts: new Map([...this.contacts].map(([key, contact]) => [key, { ...contact }])),
      leads: new Map([...this.leads].map(([key, lead]) => [key, { ...lead }])),
      events: new Map([...this.events].map(([key, event]) => [key, cloneEvent(event)])),
      payloads: new Map([...this.payloads].map(([key, inbound]) => [key, { ...inbound }])),
      messages: this.messages.map((row) => ({
        phone: row.phone,
        message: cloneMessage(row.message),
      })),
      contactWrites: this.contactWrites,
    };
  }

  private restore(snapshot: Snapshot): void {
    this.contacts = snapshot.contacts;
    this.leads = snapshot.leads;
    this.events = snapshot.events;
    this.payloads = snapshot.payloads;
    this.messages = snapshot.messages;
    this.contactWrites = snapshot.contactWrites;
  }
}

function cloneMessage(message: HistoryMessage): HistoryMessage {
  return {
    role: message.role,
    parts: JSON.parse(JSON.stringify(message.parts)) as unknown[],
  };
}

function cloneEvent(event: StoredEvent): StoredEvent {
  return { ...event, deliveries: event.deliveries.map(cloneDelivery) };
}

function cloneDelivery(delivery: Delivery): Delivery {
  return { ...delivery, reply: cloneReply(delivery.reply) };
}

function cloneReply(reply: Reply): Reply {
  if (reply.kind === "text") return { ...reply };
  return {
    kind: "template",
    templateName: reply.templateName,
    language: reply.language,
    ...(reply.bodyParams ? { bodyParams: [...reply.bodyParams] } : {}),
  };
}
