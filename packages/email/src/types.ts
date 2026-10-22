import type { EmailProviderName } from "@contestly/shared";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** One email provider. Adding one is a file implementing this plus a line in senders.ts. */
export interface EmailSender {
  readonly name: EmailProviderName;
  /** Resolves when the provider accepted the message; throws otherwise. */
  send(message: EmailMessage): Promise<void>;
}

/** Who the mail is from: env/secrets only, never admin or the database. */
export interface EmailFrom {
  address: string;
  name: string;
}
