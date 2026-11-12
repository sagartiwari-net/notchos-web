// Invoice rows + a tiny PDF (no extra dependency) for the purchase email.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../db/pool.ts';
import { selectOne, write } from '../db/pool.ts';
import type { LicensePlan } from './licenses.ts';

export interface NewInvoice {
  paymentId: number | null;
  licenseId: number;
  payerEmail: string;
  plan: LicensePlan;
  listAmount: string;
  discountAmount: string;
  totalAmount: string;
  couponId: number | null;
  couponPercent: number | null;
  provider: 'paypal' | 'stripe' | 'manual';
}

export interface CreatedInvoice {
  id: number;
  number: string;
  pdfPath: string;
}

async function nextInvoiceNumber(q: Queryable, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `NOS-${year}-`;
  const last = await selectOne<{ number: string }>(
    q,
    `SELECT number FROM invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`],
  );
  let seq = 1;
  if (last) {
    const tail = last.number.slice(prefix.length);
    const n = Number(tail);
    if (Number.isFinite(n) && n >= 1) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(6, '0')}`;
}

/** Minimal one-page PDF with Helvetica text lines. */
export function buildSimplePdf(lines: string[]): Buffer {
  const escaped = lines.map((line) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  let content = 'BT /F1 11 Tf 50 780 Td 14 TL\n';
  for (let i = 0; i < escaped.length; i++) {
    if (i === 0) content += `(${escaped[i]}) Tj\n`;
    else content += `T* (${escaped[i]}) Tj\n`;
  }
  content += 'ET';
  const contentBuf = Buffer.from(content, 'utf8');

  const objects: string[] = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objects.push(
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n',
  );
  objects.push(`4 0 obj<< /Length ${contentBuf.length} >>stream\n${content}endstream\nendobj\n`);
  objects.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xref = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

export async function createInvoice(
  q: Queryable,
  input: NewInvoice,
  now: Date,
  mailDir: string,
): Promise<CreatedInvoice> {
  const number = await nextInvoiceNumber(q, now);
  const dir = join(mailDir, 'invoices');
  mkdirSync(dir, { recursive: true });
  const pdfPath = join(dir, `${number}.pdf`);

  const lines = [
    'NotchOS Invoice',
    `Invoice: ${number}`,
    `Date (UTC): ${now.toISOString().slice(0, 19)}Z`,
    `Bill to: ${input.payerEmail}`,
    `Plan: ${input.plan}`,
    `List: USD ${input.listAmount}`,
    `Discount: USD ${input.discountAmount}${input.couponPercent ? ` (${input.couponPercent}% coupon)` : ''}`,
    `Total paid: USD ${input.totalAmount}`,
    `Provider: ${input.provider}`,
    'Key and activation instructions are in the purchase email.',
  ];
  writeFileSync(pdfPath, buildSimplePdf(lines));

  const result = await write(
    q,
    `INSERT INTO invoices
       (number, payment_id, license_id, payer_email, plan, currency, list_amount, discount_amount,
        tax_amount, total_amount, coupon_id, coupon_percent, provider, pdf_path, created_at)
     VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, 0.00, ?, ?, ?, ?, ?, ?)`,
    [
      number,
      input.paymentId,
      input.licenseId,
      input.payerEmail,
      input.plan,
      input.listAmount,
      input.discountAmount,
      input.totalAmount,
      input.couponId,
      input.couponPercent,
      input.provider,
      pdfPath,
      now,
    ],
  );

  return { id: result.insertId, number, pdfPath };
}
