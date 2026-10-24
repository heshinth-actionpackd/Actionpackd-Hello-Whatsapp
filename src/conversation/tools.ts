import { z } from "zod";
import { type Lead } from "../domain.js";

/**
 * Function tools sent to Gemini on every request. `functionDeclarations()`
 * is the shape `@google/genai` expects (`parametersJsonSchema`).
 */
export const FUNCTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "save_lead",
      description:
        "Save or update what this person has told you. Call this as soon as they share a name, a business type, what they need, whether they have a WhatsApp Business number, or any other useful detail. Omit fields you do not know. Do not invent values.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Their name, if they gave one.",
          },
          business_type: {
            type: "string",
            description:
              "What they run, in their words. Examples: B2C bakery, fleet workshop, clinic, salon, gym, real estate, distributor.",
          },
          need: {
            type: "string",
            description:
              "Which product they want, or a short description of the job. Examples: Follow-Up Bot, Reminder Bot, Business Agents, Media Agents, plans and price.",
          },
          has_whatsapp_business_number: {
            type: "boolean",
            description:
              "True when they already have a WhatsApp Business number, false when they say they do not.",
          },
          notes: {
            type: "string",
            description: "Anything else the team should know. Do not repeat the other fields.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_team",
      description:
        "Hand this chat to the Actionpackd team. Call this when they ask to talk to the team, a person, sales, or support, or when you cannot answer from the knowledge section. summary is a short brief: who they are, the business, what they want, and the details they gave. After this returns, tell them the team has it. Do not ask a follow-up question. The bot stops replying to them until the team turns it back on.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "Brief for the team. One to four sentences. No phone number; the app adds that.",
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_over",
      description:
        "Forget the current conversation. Call this when they want to start again, restart, or go back to the main menu. The next message they send starts a fresh chat. Confirm briefly and offer the five opening choices as a numbered list.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
] as const;

export function functionDeclarations(): {
  name: string;
  description: string;
  parametersJsonSchema: unknown;
}[] {
  return FUNCTION_TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parametersJsonSchema: tool.function.parameters,
  }));
}

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(max).optional(),
  );

const optionalBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const norm = value.trim().toLowerCase();
  if (norm === "true" || norm === "yes" || norm === "y") return true;
  if (norm === "false" || norm === "no" || norm === "n") return false;
  return value;
}, z.boolean().optional());

const saveLeadSchema = z.object({
  name: optionalText(80),
  business_type: optionalText(160),
  need: optionalText(300),
  has_whatsapp_business_number: optionalBoolean,
  notes: optionalText(1000),
});

const handoffSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
});

const startOverSchema = z.object({}).strip();

export interface ToolOutcome {
  result: Record<string, unknown>;
  lead?: Lead;
  humanTakeover?: boolean;
  resetConversation?: boolean;
  teamSummary?: string;
}

export function runTool(name: string, rawArguments: unknown, lead: Lead): ToolOutcome {
  const args = parseToolArguments(rawArguments);
  try {
    switch (name) {
      case "save_lead":
        return saveLead(args, lead);
      case "handoff_to_team":
        return handoff(args);
      case "start_over":
        return startOver(args);
      default:
        return { result: { ok: false, error: "unknown_tool", tool: name } };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "tool_failed";
    return { result: { ok: false, error: "tool_failed", detail: message } };
  }
}

export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function saveLead(args: unknown, lead: Lead): ToolOutcome {
  const parsed = saveLeadSchema.safeParse(args);
  if (!parsed.success) return invalid(parsed.error.issues.map((issue) => issue.message));
  const patch = parsed.data;
  if (
    patch.name === undefined &&
    patch.business_type === undefined &&
    patch.need === undefined &&
    patch.has_whatsapp_business_number === undefined &&
    patch.notes === undefined
  ) {
    return { result: { ok: false, error: "nothing_to_save" } };
  }
  const next: Lead = {
    ...lead,
    name: patch.name ?? lead.name,
    businessType: patch.business_type ?? lead.businessType,
    need: patch.need ?? lead.need,
    hasWhatsappBusinessNumber: patch.has_whatsapp_business_number ?? lead.hasWhatsappBusinessNumber,
    notes: patch.notes ?? lead.notes,
  };
  return {
    lead: next,
    result: {
      ok: true,
      lead: {
        name: next.name,
        business_type: next.businessType,
        need: next.need,
        has_whatsapp_business_number: next.hasWhatsappBusinessNumber,
        notes: next.notes,
      },
    },
  };
}

function handoff(args: unknown): ToolOutcome {
  const parsed = handoffSchema.safeParse(args);
  if (!parsed.success) return invalid(parsed.error.issues.map((issue) => issue.message));
  return {
    humanTakeover: true,
    teamSummary: parsed.data.summary,
    result: {
      ok: true,
      human_takeover: true,
      team_notified: true,
      note: "The team has the summary. Confirm that in one short message. Do not ask a follow-up question.",
    },
  };
}

function startOver(args: unknown): ToolOutcome {
  const parsed = startOverSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid(parsed.error.issues.map((issue) => issue.message));
  return {
    resetConversation: true,
    result: {
      ok: true,
      restarted: true,
      note: "The next user message starts a fresh chat. Confirm briefly and show the five opening choices as a numbered list.",
    },
  };
}

function invalid(issues: string[]): ToolOutcome {
  return { result: { ok: false, error: "invalid_arguments", issues } };
}
