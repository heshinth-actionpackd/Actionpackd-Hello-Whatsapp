import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `agent/instructions.md` from either `src/gemini` or `dist/gemini`. */
export function loadSystemInstruction(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../agent/instructions.md");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new Error(`Could not read ${path}: ${detail}`, { cause: error });
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`agent/instructions.md at ${path} is empty`);
  return trimmed;
}
