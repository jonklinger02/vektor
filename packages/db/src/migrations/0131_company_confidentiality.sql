ALTER TABLE "companies" ADD COLUMN "default_confidentiality" text DEFAULT 'public' NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "privacy_mode" boolean DEFAULT false NOT NULL;
