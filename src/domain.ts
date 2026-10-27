export const CHANNELS = ["whatsapp"] as const;
export type ChannelId = (typeof CHANNELS)[number];

/** Channel-agnostic reply. Adapters decide how to deliver it. */
export type Reply =
  | { kind: "text"; body: string }
  | { kind: "template"; templateName: string; language: string; bodyParams?: string[] };

/** One outbound message produced by a turn. The core does not pick a provider. */
export interface Delivery {
  channel: ChannelId;
  to: string;
  reply: Reply;
}

/** Normalized inbound turn. */
export interface InboundMessage {
  channel: ChannelId;
  eventId: string;
  channelUserId: string;
  phone: string | null;
  text: string | null;
  buttonId: string | null;
}

export interface Contact {
  phone: string;
  channel: ChannelId;
  humanTakeover: boolean;
  lastInboundAt: string | null;
}

export interface Lead {
  phone: string;
  name: string | null;
  businessType: string | null;
  need: string | null;
  hasWhatsappBusinessNumber: boolean | null;
  notes: string | null;
}

export interface StoredEvent {
  eventId: string;
  channel: ChannelId;
  status: "processing" | "processed";
  deliveries: Delivery[];
}

export function isChannelId(value: string): value is ChannelId {
  return (CHANNELS as readonly string[]).includes(value);
}

export function blankLead(phone: string): Lead {
  return {
    phone,
    name: null,
    businessType: null,
    need: null,
    hasWhatsappBusinessNumber: null,
    notes: null,
  };
}
