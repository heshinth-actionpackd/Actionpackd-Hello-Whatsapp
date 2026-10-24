-- Actionpackd Hello. One row per WhatsApp phone, the lead we have saved for
-- them, and inbound event ids so a webhook retry cannot run the turn twice.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE contacts (
  phone TEXT PRIMARY KEY CHECK (phone ~ '^[0-9]{8,15}$'),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp')),
  mistral_conversation_id TEXT,
  human_takeover BOOLEAN NOT NULL DEFAULT FALSE,
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER contacts_set_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Sparse lead fields. save_lead upserts this row. Omitted fields stay as they were.
CREATE TABLE leads (
  phone TEXT PRIMARY KEY REFERENCES contacts (phone) ON DELETE CASCADE,
  name TEXT,
  business_type TEXT,
  need TEXT,
  has_whatsapp_business_number BOOLEAN,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER leads_set_updated_at
BEFORE UPDATE ON leads
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Inbound Actionpackd event ids. status stays 'processing' until replies are
-- sent, so a webhook retry can resend the same deliveries and cannot apply
-- the turn twice. deliveries is a JSON array of { channel, to, reply }.
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed')),
  deliveries JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
