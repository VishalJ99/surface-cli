import { z } from "zod";

export const providerSchema = z.enum(["gmail", "outlook"]);
export type MailProvider = z.infer<typeof providerSchema>;

export const accountInputSchema = z.object({
  name: z.string().trim().min(1),
  provider: providerSchema,
  transport: z.string().trim().min(1),
  email: z.email(),
});

export const accountIdentityInputSchema = z.object({
  primary_email: z.email().optional(),
  display_name: z.string().trim().min(1).optional(),
  email_aliases: z.array(z.email()).optional(),
  name_aliases: z.array(z.string().trim().min(1)).optional(),
  clear_email_aliases: z.boolean().optional(),
  clear_name_aliases: z.boolean().optional(),
});

export type AccountIdentitySource = "configured" | "provider_verified" | "user_confirmed";

export interface MailAccount {
  account_id: string;
  name: string;
  provider: MailProvider;
  transport: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface AccountIdentity {
  account_id: string;
  primary_email: string;
  display_name: string | null;
  email_aliases: string[];
  name_aliases: string[];
  primary_email_source: AccountIdentitySource;
  display_name_source: AccountIdentitySource | null;
  verified_at: string | null;
  updated_at: string;
}
