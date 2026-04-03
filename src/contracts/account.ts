import { z } from "zod";

export const providerSchema = z.enum(["gmail", "outlook"]);
export type MailProvider = z.infer<typeof providerSchema>;

export const accountInputSchema = z.object({
  name: z.string().trim().min(1),
  provider: providerSchema,
  transport: z.string().trim().min(1),
  email: z.email(),
});

export interface MailAccount {
  account_id: string;
  name: string;
  provider: MailProvider;
  transport: string;
  email: string;
  created_at: string;
  updated_at: string;
}
