import type { ChannelAdapter, OutboundDelivery } from "../adapter.js";
import type { ActionpackdClient } from "./client.js";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;

  constructor(private readonly client: ActionpackdClient) {}

  async send(delivery: OutboundDelivery): Promise<void> {
    await this.client.sendMessage({
      to: delivery.to,
      idempotencyKey: delivery.idempotencyKey,
      reply: delivery.reply,
    });
  }
}
