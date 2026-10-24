import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const phoneDigits = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\D/g, ""))
  .refine((digits) => digits.length >= 8 && digits.length <= 15, {
    message: "must contain 8 to 15 digits",
  });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  ACTIONPACKD_API_KEY: z.string().min(1),
  ACTIONPACKD_WEBHOOK_SECRET: z.string().min(1),
  ACTIONPACKD_BASE_URL: z.string().url().default("https://api.actionpackd.com/v1"),
  MISTRAL_API_KEY: z.string().min(1),
  MISTRAL_AGENT_ID: z.string().min(1),
  MISTRAL_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  TEAM_WHATSAPP_NUMBER: phoneDigits,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment:\n${details}`);
  }
  return parsed.data;
}
