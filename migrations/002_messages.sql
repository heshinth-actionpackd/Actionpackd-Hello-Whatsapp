-- Gemini is stateless. Replay recent rows on each request. parts is a JSON
-- array of content parts: text, functionCall (with thoughtSignature when the
-- API sent one), and functionResponse. Forward-only: the Mistral conversation
-- id is dropped here and not recreated.

ALTER TABLE contacts DROP COLUMN mistral_conversation_id;

CREATE TABLE messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone TEXT NOT NULL REFERENCES contacts (phone) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  parts JSONB NOT NULL CHECK (jsonb_typeof(parts) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_phone_created_at_idx ON messages (phone, created_at, id);
