import type { ChannelId, Reply } from "../domain.js";

export interface OutboundDelivery {
  to: string;
  reply: Reply;
  idempotencyKey: string;
}

/** One implementation per channel. The conversation core never calls a provider directly. */
export interface ChannelAdapter {
  readonly channel: ChannelId;
  send(delivery: OutboundDelivery): Promise<void>;
}
