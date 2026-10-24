import type { AgentClient } from "../agent/types.js";
import type { Contact, Delivery, InboundMessage, Lead } from "../domain.js";
import { blankLead } from "../domain.js";
import type { Log } from "../log.js";
import { silentLog } from "../log.js";
import type { HelloStore } from "../store.js";
import { runAgentTurn } from "./agent-loop.js";
import { isGreeting, isResetCommand, openingChoice, parseBotOn, userText } from "./commands.js";
import { NON_TEXT_REPLY, TEAM_HELP, teamResumed, teamUnknownContact } from "./copy.js";
import type { HistoryMessage } from "./history.js";
import { menuReply, teamAlertReply } from "./templates.js";

export interface TurnDeps {
  store: HelloStore;
  agent: AgentClient;
  teamPhone: string;
  log?: Log;
}

interface Plan {
  contacts: Contact[];
  lead: Lead | null;
  deliveries: Delivery[];
  /** When clear is set, this phone's history is deleted and `messages` is ignored. */
  history: { clear: boolean; messages: HistoryMessage[] };
}

function keepHistory(): Plan["history"] {
  return { clear: false, messages: [] };
}

/**
 * Claims the event. `done` means a previous attempt already finished and the
 * caller should ack without doing more work. Database errors propagate so the
 * webhook can answer 500 and let Actionpackd retry.
 */
export async function acceptInbound(
  store: HelloStore,
  message: InboundMessage,
): Promise<"process" | "done"> {
  return store.transact(async (tx) => {
    const begun = await tx.beginEvent(message.eventId, message.channel);
    if (begun.status === "existing" && begun.event.status === "processed") return "done";
    return "process";
  });
}

/**
 * Runs one inbound message while holding the per-phone lock: plan, persist,
 * send, then mark the event processed. A second delivery of the same event
 * resends the saved deliveries and does not call Gemini again.
 */
export async function runTurn(
  deps: TurnDeps,
  message: InboundMessage,
  deliver: (deliveries: Delivery[]) => Promise<void>,
): Promise<void> {
  const phone = message.phone ?? message.channelUserId;
  const log = deps.log ?? silentLog;
  await deps.store.lock(phone, async () => {
    const begun = await deps.store.transact((tx) =>
      tx.beginEvent(message.eventId, message.channel),
    );
    if (begun.status === "existing" && begun.event.status === "processed") return;
    if (begun.status === "existing" && begun.event.deliveries.length > 0) {
      await deliver(begun.event.deliveries);
      await deps.store.markEventProcessed(message.eventId);
      log.info({ eventId: message.eventId, resent: true }, "resent saved deliveries");
      return;
    }

    const loaded = await deps.store.transact(async (tx) => ({
      contact: await tx.getContact(phone),
      lead: await tx.getLead(phone),
    }));
    const plan = await planTurn(
      deps,
      message,
      phone,
      loaded.contact,
      loaded.lead ?? blankLead(phone),
    );

    await deps.store.transact(async (tx) => {
      for (const contact of plan.contacts) await tx.saveContact(contact);
      if (plan.lead) await tx.saveLead(plan.lead);
      if (plan.history.clear) await tx.clearMessages(phone);
      else if (plan.history.messages.length > 0) {
        await tx.appendMessages(phone, plan.history.messages);
      }
      await tx.saveEventDeliveries(message.eventId, plan.deliveries);
    });

    if (plan.deliveries.length > 0) await deliver(plan.deliveries);
    await deps.store.markEventProcessed(message.eventId);
    log.info(
      { eventId: message.eventId, deliveries: plan.deliveries.length },
      "finished inbound turn",
    );
  });
}

async function planTurn(
  deps: TurnDeps,
  message: InboundMessage,
  phone: string,
  existing: Contact | null,
  lead: Lead,
): Promise<Plan> {
  const log = deps.log ?? silentLog;
  const text = userText(message);

  if (phone === deps.teamPhone) {
    return teamPlan(deps, message, phone, text);
  }

  const contact: Contact = existing ?? {
    phone,
    channel: message.channel,
    humanTakeover: false,
    lastInboundAt: null,
  };
  contact.lastInboundAt = new Date().toISOString();

  if (contact.humanTakeover) {
    log.info({ eventId: message.eventId }, "ignored inbound during human takeover");
    return { contacts: [contact], lead: null, deliveries: [], history: keepHistory() };
  }

  if (!text) {
    return {
      contacts: [contact],
      lead: null,
      deliveries: [textDelivery(message, phone, NON_TEXT_REPLY)],
      history: keepHistory(),
    };
  }

  if (isResetCommand(text)) {
    return {
      contacts: [contact],
      lead: null,
      deliveries: [menuDelivery(message, phone)],
      history: { clear: true, messages: [] },
    };
  }

  const hasHistory = await deps.store.transact((tx) => tx.hasMessages(phone));
  if (!hasHistory && isGreeting(text)) {
    return {
      contacts: [contact],
      lead: null,
      deliveries: [menuDelivery(message, phone)],
      history: keepHistory(),
    };
  }

  const choice = hasHistory ? null : openingChoice(text);
  const turn = await runAgentTurn({
    agent: deps.agent,
    phone,
    userText: choice ?? text,
    lead,
    log,
  });
  if (turn.humanTakeover) contact.humanTakeover = true;

  const deliveries: Delivery[] = [textDelivery(message, phone, turn.text)];
  if (turn.teamSummary) {
    deliveries.push({
      channel: message.channel,
      to: deps.teamPhone,
      reply: teamAlertReply(phone, turn.teamSummary),
    });
  }
  return {
    contacts: [contact],
    lead: turn.lead,
    deliveries,
    history: turn.resetConversation
      ? { clear: true, messages: [] }
      : { clear: false, messages: turn.messages },
  };
}

async function teamPlan(
  deps: TurnDeps,
  message: InboundMessage,
  phone: string,
  text: string | null,
): Promise<Plan> {
  const target = text ? parseBotOn(text) : null;
  if (!target) {
    return {
      contacts: [],
      lead: null,
      deliveries: [textDelivery(message, phone, TEAM_HELP)],
      history: keepHistory(),
    };
  }

  const customer = await deps.store.transact((tx) => tx.getContact(target));
  if (!customer) {
    return {
      contacts: [],
      lead: null,
      deliveries: [textDelivery(message, phone, teamUnknownContact(target))],
      history: keepHistory(),
    };
  }

  customer.humanTakeover = false;
  return {
    contacts: [customer],
    lead: null,
    deliveries: [textDelivery(message, phone, teamResumed(target))],
    history: keepHistory(),
  };
}

function textDelivery(message: InboundMessage, to: string, body: string): Delivery {
  return { channel: message.channel, to, reply: { kind: "text", body } };
}

function menuDelivery(message: InboundMessage, to: string): Delivery {
  return { channel: message.channel, to, reply: menuReply() };
}
