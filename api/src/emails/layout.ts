/**
 * Light-theme HTML shell for NotchOS transactional mail.
 * Tables + inline CSS for Gmail / Apple Mail / Outlook.com.
 */

const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" role="img" aria-label="NotchOS">
  <rect x="1.25" y="2.75" width="21.5" height="18.5" rx="5.25" stroke="#111111" stroke-width="1.6"/>
  <path d="M6.5 2.75h11c-1.1 0-2 .9-2 2v1.2a2.8 2.8 0 0 1-2.8 2.8h-1.4a2.8 2.8 0 0 1-2.8-2.8V4.75c0-1.1-.9-2-2-2z" fill="#111111"/>
</svg>`;

export interface LayoutInput {
  preheader?: string;
  title: string;
  bodyHtml: string;
  /** Primary button label + href. */
  cta?: { label: string; href: string };
  /** Optional second button. */
  secondaryCta?: { label: string; href: string };
  footerNote?: string;
  siteUrl?: string;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLayout(input: LayoutInput): string {
  const site = input.siteUrl ?? 'https://notchos.app';
  const preheader = input.preheader ?? input.title;
  const ctaBlock =
    input.cta === undefined
      ? ''
      : `
      <tr>
        <td style="padding:8px 0 4px;">
          <a href="${esc(input.cta.href)}" style="display:inline-block;background:#111111;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:10px;letter-spacing:-0.01em;">
            ${esc(input.cta.label)}
          </a>
        </td>
      </tr>`;
  const secondary =
    input.secondaryCta === undefined
      ? ''
      : `
      <tr>
        <td style="padding:10px 0 0;">
          <a href="${esc(input.secondaryCta.href)}" style="display:inline-block;color:#111111;font-size:14px;font-weight:600;text-decoration:underline;text-underline-offset:3px;">
            ${esc(input.secondaryCta.label)}
          </a>
        </td>
      </tr>`;
  const footerNote = input.footerNote
    ? `<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#737373;">${esc(input.footerNote)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${esc(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#111111;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 12px;border-bottom:1px solid #f0f0f2;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">${MARK_SVG}</td>
                  <td style="vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;letter-spacing:-0.03em;color:#111111;">NotchOS</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.03em;color:#111111;">${esc(input.title)}</h1>
              <div style="font-size:15px;line-height:1.6;color:#3f3f46;">
                ${input.bodyHtml}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                ${ctaBlock}
                ${secondary}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 24px;background:#fafafa;border-top:1px solid #f0f0f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              ${footerNote}
              <p style="margin:0;font-size:12px;line-height:1.5;color:#a1a1aa;">
                NotchOS for Mac · Apple silicon · macOS 26 or later<br />
                <a href="${esc(site)}" style="color:#71717a;text-decoration:underline;">${esc(site.replace(/^https?:\/\//, ''))}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function paragraphs(lines: string[]): string {
  return lines.map((line) => `<p style="margin:0 0 14px;">${line}</p>`).join('\n');
}

export function codeBlock(value: string): string {
  return `<p style="margin:0 0 14px;"><code style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:10px 12px;color:#111111;letter-spacing:0.02em;">${esc(value)}</code></p>`;
}

export function bulletList(items: string[]): string {
  const lis = items.map((item) => `<li style="margin:0 0 6px;">${item}</li>`).join('');
  return `<ul style="margin:0 0 14px;padding-left:20px;color:#3f3f46;">${lis}</ul>`;
}

export function textVersion(parts: string[]): string {
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

export { esc };
