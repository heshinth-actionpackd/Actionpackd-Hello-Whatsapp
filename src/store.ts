import type { HistoryMessage } from "./conversation/history.js";
import type { ChannelId, Contact, Delivery, Lead, StoredEvent } from "./domain.js";

export type BeginEventResult = { status: "new" } | { status: "existing"; event: StoredEvent };

/**
 * Work inside one transaction. The per-phone lock is separate: it is held for
 * the whole turn, including the Gemini call, and the transaction is not.
 */
export interface HelloTx {
  beginEvent(eventId: string, channel: ChannelId): Promise<BeginEventResult>;
  saveEventDeliveries(eventId: string, deliveries: Delivery[]): Promise<void>;
  getContact(phone: string): Promise<Contact | null>;
  saveContact(contact: Contact): Promise<void>;
  getLead(phone: string): Promise<Lead | null>;
  saveLead(lead: Lead): Promise<void>;
  /** Newest `limit` rows, oldest first. */
  listMessages(phone: string, limit: number): Promise<HistoryMessage[]>;
  hasMessages(phone: string): Promise<boolean>;
  appendMessages(phone: string, messages: HistoryMessage[]): Promise<void>;
  clearMessages(phone: string): Promise<void>;
}

export interface HelloStore {
  /**
   * Serializes turns for one phone. Postgres takes a session advisory lock on
   * a dedicated connection. The in-memory store used by tests chains promises.
   */
  lock<T>(phone: string, fn: () => Promise<T>): Promise<T>;
  transact<T>(fn: (tx: HelloTx) => Promise<T>): Promise<T>;
  markEventProcessed(eventId: string): Promise<void>;
  ping(): Promise<void>;
}
