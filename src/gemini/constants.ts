/** Stable Gemini API model code. Flash Lite on the AI Studio free tier. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** Per-request cap. SDK retries are off, so a timeout becomes the fallback reply. */
export const GEMINI_TIMEOUT_MS = 20_000;
