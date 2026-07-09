/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { Attachment, SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';

/** A nodemailer attachment carrying inline base64 content. */
interface MailAttachment {
  filename: string;
  content: string;
  encoding: 'base64';
  contentType?: string;
}

/**
 * Return a valid `type/subtype` content-type (params stripped), or undefined if the
 * value is malformed — e.g. the `text/plain/octet-stream` (two slashes) that an
 * IMAP round-trip can yield. A malformed Content-Type is rejected by the Proton
 * bridge's strict MIME parser ("unexpected content after media subtype"), so we omit
 * it and let nodemailer infer a valid type from the filename instead.
 */
function sanitizeContentType(ct?: string): string | undefined {
  if (!ct) return undefined;
  const base = ct.split(';')[0].trim();
  return /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(base) ? base : undefined;
}

/** Map inline-base64 attachments onto nodemailer's attachment shape. */
function mapAttachments(attachments?: Attachment[]): MailAttachment[] {
  return (attachments ?? []).map((a) => {
    const contentType = sanitizeContentType(a.mime_type);
    return {
      filename: a.filename,
      content: a.content_base64,
      encoding: 'base64' as const,
      ...(contentType ? { contentType } : {}),
    };
  });
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: Attachment[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const mapped = mapAttachments(options.attachments);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(mapped.length ? { attachments: mapped } : {}),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
      attachments?: Attachment[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const transport = await this.connections.getSmtpTransport(accountName);

    const mapped = mapAttachments(options.attachments);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(mapped.length ? { attachments: mapped } : {}),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      attachments?: Attachment[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    const originalBody = original.bodyText ?? original.bodyHtml ?? '';
    const fullBody = (options.body ?? '') + forwardHeader + originalBody;

    // Carry the original message's attachments forward, fetched inline as
    // base64. A per-file fetch failure (e.g. over the download cap) is skipped
    // with a warning rather than failing the whole forward.
    const originalMetas = original.attachments ?? [];
    const settled = await Promise.allSettled(
      originalMetas.map(async (meta) => {
        const dl = await this.imapService.downloadAttachment(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
          meta.filename,
        );
        return dl;
      }),
    );

    const warnings: string[] = [];
    const originalAttachments: MailAttachment[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        const dl = outcome.value;
        const contentType = sanitizeContentType(dl.mimeType);
        originalAttachments.push({
          filename: dl.filename,
          content: dl.contentBase64,
          encoding: 'base64',
          ...(contentType ? { contentType } : {}),
        });
      } else {
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        warnings.push(`Skipped original attachment "${originalMetas[i].filename}": ${reason}`);
      }
    });

    const mapped = [...originalAttachments, ...mapAttachments(options.attachments)];

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
      ...(mapped.length ? { attachments: mapped } : {}),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      ...(warnings.length ? { warnings } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
