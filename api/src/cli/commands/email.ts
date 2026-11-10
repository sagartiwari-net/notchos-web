import { parseArgs } from 'node:util';
import { parseMailConfig } from '../../emails/mail-config.ts';
import { previewTemplate, sendTemplate } from '../../emails/mailer.ts';
import { EMAIL_TEMPLATE_IDS, getPreset, sampleVars } from '../../emails/presets.ts';
import type { EmailTemplateId } from '../../emails/types.ts';
import type { CliIo, Command } from '../command.ts';
import { UsageError } from '../command.ts';

function parse(args: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>['options']) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function templateId(text: string | undefined): EmailTemplateId {
  if (text === undefined) throw new UsageError('expected a template id');
  getPreset(text);
  return text as EmailTemplateId;
}

const list: Command = {
  name: 'email:list',
  summary: 'List email template presets',
  usage: '',
  async run(_args, io) {
    for (const id of EMAIL_TEMPLATE_IDS) {
      io.out(`${id.padEnd(22)}  ${getPreset(id).summary}`);
    }
    return 0;
  },
};

const preview: Command = {
  name: 'email:preview',
  summary: 'Render a preset to ~/.notchos-dev/mail (HTML + text)',
  usage: '<template> [--to email]',
  async run(args, io) {
    const { values, positionals } = parse(args, { to: { type: 'string' } });
    const id = templateId(positionals[0]);
    if (positionals.length > 1) throw new UsageError('unexpected extra arguments');
    const mail = parseMailConfig(io.env);
    const result = await previewTemplate(mail, id, values.to);
    io.out(`template  ${result.template}`);
    io.out(`to        ${result.to}`);
    io.out(`subject   ${result.subject}`);
    io.out(`wrote     ${result.path}`);
    io.out(`mode      file (preview always writes locally)`);
    return 0;
  },
};

const sendTest: Command = {
  name: 'email:send-test',
  summary: 'Send or file-save a preset (Gmail SMTP when MAIL_MODE=smtp)',
  usage: '<template> --to email',
  async run(args, io) {
    const { values, positionals } = parse(args, { to: { type: 'string' } });
    const id = templateId(positionals[0]);
    if (positionals.length > 1) throw new UsageError('unexpected extra arguments');
    if (values.to === undefined || values.to.trim() === '') {
      throw new UsageError('--to email is required');
    }
    const mail = parseMailConfig(io.env);
    const vars = sampleVars(id, values.to.trim());
    const result = await sendTemplate(mail, id, vars);
    io.out(`template  ${result.template}`);
    io.out(`to        ${result.to}`);
    io.out(`subject   ${result.subject}`);
    io.out(`mode      ${result.mode}`);
    if (result.path) io.out(`wrote     ${result.path}`);
    if (result.messageId) io.out(`message   ${result.messageId}`);
    if (result.mode === 'file') {
      io.out('hint      Set SMTP_USER + SMTP_PASS (Gmail app password) and MAIL_MODE=smtp to send for real.');
    }
    return 0;
  },
};

const previewAll: Command = {
  name: 'email:preview-all',
  summary: 'Write every preset HTML into the mail folder',
  usage: '[--to email]',
  async run(args, io) {
    const { values, positionals } = parse(args, { to: { type: 'string' } });
    if (positionals.length > 0) throw new UsageError('unexpected arguments');
    const mail = parseMailConfig(io.env);
    for (const id of EMAIL_TEMPLATE_IDS) {
      const result = await previewTemplate(mail, id, values.to);
      io.out(`${id.padEnd(22)}  ${result.path}`);
    }
    return 0;
  },
};

export const emailCommands: Command[] = [list, preview, sendTest, previewAll];
