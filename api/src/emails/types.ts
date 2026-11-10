/** Shared shapes for transactional email presets. */

export type EmailTemplateId =
  | 'trial_started'
  | 'trial_download'
  | 'purchase_monthly'
  | 'purchase_lifetime'
  | 'key_resend'
  | 'license_expired'
  | 'license_expiring'
  | 'multiple_device'
  | 'license_revoked'
  | 'promo_buy'
  | 'promo_trial_ending';

export interface EmailVars {
  /** Buyer or recipient display name, if known. */
  name?: string;
  /** Destination address (PayPal email for paid keys). */
  email: string;
  plan?: 'monthly' | 'lifetime' | 'trial';
  /** Clear-text key — only for purchase / resend templates. */
  key?: string;
  /** ISO date or human date string for expiry. */
  expiresAt?: string;
  daysLeft?: number;
  deviceName?: string;
  downloadUrl?: string;
  pricingUrl?: string;
  siteUrl?: string;
  supportEmail?: string;
  /** Optional promo overrides. */
  promoHeadline?: string;
  promoBody?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailPreset {
  id: EmailTemplateId;
  /** One-line description for CLI help. */
  summary: string;
  render(vars: EmailVars): RenderedEmail;
}
