CREATE TABLE "contacts" (
	"phone" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"human_takeover" boolean DEFAULT false NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_phone_digits" CHECK ("contacts"."phone" ~ '^[0-9]{8,15}$'),
	CONSTRAINT "contacts_channel_whatsapp" CHECK ("contacts"."channel" in ('whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"phone" text PRIMARY KEY NOT NULL,
	"name" text,
	"business_type" text,
	"need" text,
	"has_whatsapp_business_number" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"phone" text NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role" CHECK ("messages"."role" in ('user', 'model')),
	CONSTRAINT "messages_parts_array" CHECK (jsonb_typeof("messages"."parts") = 'array')
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "processed_events_channel_whatsapp" CHECK ("processed_events"."channel" in ('whatsapp')),
	CONSTRAINT "processed_events_status" CHECK ("processed_events"."status" in ('processing', 'processed'))
);
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_phone_contacts_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."contacts"("phone") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_phone_contacts_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."contacts"("phone") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_phone_created_at_idx" ON "messages" USING btree ("phone","created_at","id");