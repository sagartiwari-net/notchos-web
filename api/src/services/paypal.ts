// Thin PayPal Orders REST client. Used only when PAYPAL_CLIENT_ID + PAYPAL_SECRET are set.

export interface PayPalConfig {
  clientId: string;
  secret: string;
  /** live | sandbox */
  mode: 'live' | 'sandbox';
}

export interface PayPalOrderResult {
  id: string;
  status: string;
  raw: unknown;
}

export interface PayPalCaptureResult {
  id: string;
  status: string;
  amount: string;
  currency: string;
  payerEmail: string;
  payerId: string | null;
  raw: unknown;
}

export function readPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? '';
  const secret = env.PAYPAL_SECRET?.trim() ?? '';
  if (!clientId || !secret) return null;
  const mode = env.PAYPAL_MODE?.trim() === 'live' ? 'live' : 'sandbox';
  return { clientId, secret, mode };
}

function apiBase(mode: PayPalConfig['mode']): string {
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function accessToken(cfg: PayPalConfig): Promise<string> {
  const auth = Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString('base64');
  const res = await fetch(`${apiBase(cfg.mode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal token failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('PayPal token response missing access_token');
  return json.access_token;
}

async function paypalFetch(
  cfg: PayPalConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const token = await accessToken(cfg);
  return fetch(`${apiBase(cfg.mode)}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

export async function createPayPalOrder(
  cfg: PayPalConfig,
  input: { amount: string; currency: string; plan: string; returnUrl: string; cancelUrl: string },
): Promise<PayPalOrderResult> {
  const res = await paypalFetch(cfg, '/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: input.currency, value: input.amount },
          description: `NotchOS ${input.plan}`,
          custom_id: input.plan,
        },
      ],
      application_context: {
        brand_name: 'NotchOS',
        user_action: 'PAY_NOW',
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      },
    }),
  });
  const raw = await res.json();
  if (!res.ok) {
    throw new Error(`PayPal create order failed (${res.status}): ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const body = raw as { id?: string; status?: string };
  if (!body.id) throw new Error('PayPal create order missing id');
  return { id: body.id, status: body.status ?? 'CREATED', raw };
}

export async function capturePayPalOrder(cfg: PayPalConfig, orderId: string): Promise<PayPalCaptureResult> {
  const res = await paypalFetch(cfg, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    body: '{}',
  });
  const raw = await res.json();
  if (!res.ok) {
    throw new Error(`PayPal capture failed (${res.status}): ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const body = raw as {
    id?: string;
    status?: string;
    payer?: { email_address?: string; payer_id?: string };
    purchase_units?: Array<{
      payments?: {
        captures?: Array<{
          id?: string;
          amount?: { value?: string; currency_code?: string };
          status?: string;
        }>;
      };
    }>;
  };
  const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
  const captureId = capture?.id ?? body.id;
  if (!captureId) throw new Error('PayPal capture missing id');
  const payerEmail = body.payer?.email_address?.trim().toLowerCase();
  if (!payerEmail) throw new Error('PayPal capture missing payer email');
  return {
    id: captureId,
    status: capture?.status ?? body.status ?? 'COMPLETED',
    amount: capture?.amount?.value ?? '0.00',
    currency: (capture?.amount?.currency_code ?? 'USD').toUpperCase(),
    payerEmail,
    payerId: body.payer?.payer_id ?? null,
    raw,
  };
}
