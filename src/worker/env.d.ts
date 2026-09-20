export interface Env {
  /** TPS's inbound endpoint, e.g. https://dev.novamerx.ai/tps-api/internal/email/inbound */
  TPS_INBOUND_URL: string;
  /** Secrets, set with `wrangler secret put`. Must match the TPS deployment exactly. */
  INBOUND_EMAIL_TOKEN: string;
  INBOUND_EMAIL_SIGNING_SECRET: string;
  /** Optional. Without it there is no durable retry: a message TPS cannot accept after
   *  three attempts is logged and lost, and the README says so. */
  SPOOL?: R2Bucket;
}
