// POST /api/trial-lead: website email capture + download mail (file mode).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('POST /api/trial-lead', () => {
  it('stores a lead and returns mailed', async () => {
    const email = `lead-${Date.now()}@example.com`;
    const res = await h.post('/api/trial-lead', { email }, { ip: '203.0.113.40' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'mailed', email: email.toLowerCase() });

    const rows = await h.sql.query<{ email: string; status: string; resend_count: number }[]>(
      'SELECT email, status, resend_count FROM trial_leads WHERE email = ?',
      [email.toLowerCase()],
    );
    expect(rows).toEqual([{ email: email.toLowerCase(), status: 'mailed', resend_count: 0 }]);
  });

  it('rate-limits an immediate second send for the same email', async () => {
    const email = `lead-again-${Date.now()}@example.com`;
    expect((await h.post('/api/trial-lead', { email })).status).toBe(200);
    const again = await h.post('/api/trial-lead/resend', { email });
    expect(again.status).toBe(429);
  });

  it('returns has_license when that email already has an active key', async () => {
    const license = await h.newLicense('lifetime');
    const res = await h.post('/api/trial-lead', { email: 'buyer@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'has_license', email: 'buyer@example.com' });
    void license;
  });

  it('links a trial lead when /v1/trial sends the same email', async () => {
    const email = `trial-link-${Date.now()}@example.com`;
    expect((await h.post('/api/trial-lead', { email })).status).toBe(200);

    const device = deviceId('trial-lead-link');
    const trial = await h.post('/v1/trial', { device_id: device, email, app_version: '0.7.0' });
    expect(trial.status).toBe(200);

    const rows = await h.sql.query<{ email: string | null; lead_id: number | null }[]>(
      'SELECT email, lead_id FROM trials WHERE device_id = ?',
      [device],
    );
    expect(rows[0]?.email).toBe(email.toLowerCase());
    expect(rows[0]?.lead_id).not.toBeNull();

    const lead = await h.sql.query<{ converted_trial_device_id: string | null }[]>(
      'SELECT converted_trial_device_id FROM trial_leads WHERE email = ?',
      [email.toLowerCase()],
    );
    expect(lead[0]?.converted_trial_device_id).toBe(device);
  });
});
