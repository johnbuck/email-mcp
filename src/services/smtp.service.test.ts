import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
  return {} as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    service = new SmtpService(connections, rateLimiter, createMockImapService());
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, createMockImapService());

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });

    // spec: send-email-with-attachment
    it('maps a base64 attachment to a nodemailer attachments entry', async () => {
      const contentBase64 = Buffer.from('hello attachment world').toString('base64');

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'With attachment',
        body: 'See attached.',
        attachments: [
          { filename: 'report.pdf', content_base64: contentBase64, mime_type: 'application/pdf' },
        ],
      } as unknown as Parameters<typeof service.sendEmail>[1]);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        expect.objectContaining({
          filename: 'report.pdf',
          content: contentBase64,
          encoding: 'base64',
          contentType: 'application/pdf',
        }),
      ]);
    });

    // spec: non-attachment-send-unchanged
    it('omits the attachments key entirely when none are provided', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'No attachment',
        body: 'Plain body',
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call).not.toHaveProperty('attachments');
    });
  });

  // spec: reply-attachment-preserves-threading
  describe('replyToEmail attachments', () => {
    it('includes the attachment AND the inReplyTo/references threading headers', async () => {
      const imap = {
        getEmail: vi.fn().mockResolvedValue({
          id: '1',
          messageId: '<orig@example.com>',
          references: ['<root@example.com>'],
          subject: 'Original subject',
          from: { address: 'sender@example.com' },
          to: [{ address: 'test@example.com' }],
          cc: [],
          bodyText: 'original body',
          date: new Date().toISOString(),
          attachments: [],
        }),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imap);

      const contentBase64 = Buffer.from('reply attachment bytes').toString('base64');
      await service.replyToEmail('test', {
        emailId: '1',
        body: 'my reply',
        attachments: [
          { filename: 'note.txt', content_base64: contentBase64, mime_type: 'text/plain' },
        ],
      } as unknown as Parameters<typeof service.replyToEmail>[1]);

      const call = transport.sendMail.mock.calls[0][0];
      // Threading headers must survive the attachment change.
      expect(call.inReplyTo).toBe('<orig@example.com>');
      expect(call.references).toContain('<orig@example.com>');
      // ...and the attachment must be carried.
      expect(call.attachments).toEqual([
        expect.objectContaining({
          filename: 'note.txt',
          content: contentBase64,
          encoding: 'base64',
        }),
      ]);
    });
  });

  // spec: forward-accepts-new-attachments (+ fetches originals for forward-carries-original-attachments)
  describe('forwardEmail attachments', () => {
    it('merges the original attachment(s) with any newly-added ones', async () => {
      const originalBase64 = Buffer.from('original file bytes').toString('base64');
      const imap = {
        getEmail: vi.fn().mockResolvedValue({
          id: '7',
          messageId: '<fwd@example.com>',
          subject: 'Doc to forward',
          from: { address: 'sender@example.com' },
          to: [{ address: 'test@example.com' }],
          date: new Date().toISOString(),
          bodyText: 'see attached',
          attachments: [{ filename: 'original.pdf', mimeType: 'application/pdf', size: 4321 }],
        }),
        // Both possible fetch mechanisms are stubbed so the assertion stays
        // mechanism-agnostic (the criterion only cares about the merged list).
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'original.pdf',
          mimeType: 'application/pdf',
          size: 4321,
          contentBase64: originalBase64,
        }),
        saveEmailAttachments: vi.fn().mockResolvedValue([
          {
            filename: 'original.pdf',
            localPath: '/tmp/original.pdf',
            fileUrl: 'file:///tmp/original.pdf',
            mimeType: 'application/pdf',
            size: 4321,
          },
        ]),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imap);

      const newBase64 = Buffer.from('new file bytes').toString('base64');
      await service.forwardEmail('test', {
        emailId: '7',
        to: ['dest@example.com'],
        body: 'FYI, see below.',
        attachments: [
          { filename: 'added.txt', content_base64: newBase64, mime_type: 'text/plain' },
        ],
      } as unknown as Parameters<typeof service.forwardEmail>[1]);

      const call = transport.sendMail.mock.calls[0][0];
      const filenames = (call.attachments ?? []).map((a: { filename: string }) => a.filename);
      expect(filenames).toContain('original.pdf');
      expect(filenames).toContain('added.txt');

      // The newly-added attachment always travels as decoded base64 content.
      const added = (call.attachments ?? []).find(
        (a: { filename: string }) => a.filename === 'added.txt',
      );
      expect(added).toMatchObject({ content: newBase64, encoding: 'base64' });
    });
  });
});
