import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import audit from '../safety/audit.js';
import type SmtpService from '../services/smtp.service.js';
import registerSendTools from './send.tool.js';

// Audit is written at the tool boundary — mock it so we can assert it is
// (still) called on an attachment-carrying send.
vi.mock('../safety/audit.js', () => ({
  default: { log: vi.fn(), AUDIT_LOG_PATH: '/tmp/audit-test.log' },
}));

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}
type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResult>;

/** Capture the handlers `registerSendTools` registers on a fake MCP server. */
function captureTools(elicitInput?: unknown) {
  const handlers: Record<string, ToolHandler> = {};
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, _ann: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
    // The send-approval gate calls server.server.elicitInput(...).
    server: { elicitInput: elicitInput ?? vi.fn() },
  };
  return { server: server as unknown as McpServer, handlers };
}

function makeSmtp() {
  return {
    sendEmail: vi.fn().mockResolvedValue({ messageId: '<sent@example.com>', status: 'sent' }),
    replyToEmail: vi.fn().mockResolvedValue({ messageId: '<r@example.com>', status: 'sent' }),
    forwardEmail: vi.fn().mockResolvedValue({ messageId: '<f@example.com>', status: 'sent' }),
  };
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('send_email tool — attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // spec: attachments-are-audited
  it('writes an "ok" audit entry when a valid attachment is sent', async () => {
    const { server, handlers } = captureTools();
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    const res = await handlers.send_email({
      account: 'default',
      to: ['recipient@example.com'],
      subject: 'With attachment',
      body: 'See attached.',
      attachments: [{ filename: 'a.txt', content_base64: b64('doc'), mime_type: 'text/plain' }],
    });

    expect(res.isError).toBeFalsy();
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      'send_email',
      'default',
      expect.objectContaining({ subject: 'With attachment' }),
      'ok',
    );
  });

  // spec: rejects-invalid-base64
  it('rejects a malformed-base64 attachment and does NOT send', async () => {
    const { server, handlers } = captureTools();
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    const res = await handlers.send_email({
      account: 'default',
      to: ['recipient@example.com'],
      subject: 'Bad attachment',
      body: 'body',
      attachments: [
        {
          filename: 'bad.bin',
          content_base64: '@@@ not base64 @@@',
          mime_type: 'application/octet-stream',
        },
      ],
    });

    expect(res.isError).toBe(true);
    expect(smtp.sendEmail).not.toHaveBeenCalled();
  });

  // spec: rejects-oversize-attachment
  it('rejects attachments over 25 MB total and does NOT send', async () => {
    const { server, handlers } = captureTools();
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    const oversize = Buffer.alloc(26 * 1024 * 1024, 0x41).toString('base64');
    const res = await handlers.send_email({
      account: 'default',
      to: ['recipient@example.com'],
      subject: 'Too big',
      body: 'body',
      attachments: [
        { filename: 'big.bin', content_base64: oversize, mime_type: 'application/octet-stream' },
      ],
    });

    expect(res.isError).toBe(true);
    expect(smtp.sendEmail).not.toHaveBeenCalled();
  });
});

describe('send approval gate (MCP_EMAIL_SEND_APPROVAL=elicit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_EMAIL_SEND_APPROVAL = 'elicit';
  });
  afterEach(() => {
    delete process.env.MCP_EMAIL_SEND_APPROVAL;
  });

  it('elicits with form mode + no required schema, then sends on accept', async () => {
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: {} });
    const { server, handlers } = captureTools(elicit);
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    const res = await handlers.send_email({
      account: 'default',
      to: ['r@example.com'],
      subject: 'Hi',
      body: 'Body text',
    });

    expect(elicit).toHaveBeenCalledTimes(1);
    const arg = elicit.mock.calls[0][0] as {
      mode: string;
      message: string;
      requestedSchema: { required?: string[] };
    };
    expect(arg.mode).toBe('form');
    expect(arg.requestedSchema.required ?? []).toEqual([]);
    expect(arg.message).toContain('r@example.com');
    expect(arg.message).toContain('Hi');
    // A generous approval window (>60s default) so a human can actually approve.
    const opts = elicit.mock.calls[0][1] as { timeout?: number };
    expect(opts.timeout ?? 0).toBeGreaterThan(60_000);
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
  });

  it('does NOT send when the user declines', async () => {
    const elicit = vi.fn().mockResolvedValue({ action: 'decline' });
    const { server, handlers } = captureTools(elicit);
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    const res = await handlers.send_email({
      account: 'default',
      to: ['r@example.com'],
      subject: 'Hi',
      body: 'Body',
    });

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/not sent/i);
  });

  it('fail-closed: does NOT send when the client cannot be elicited', async () => {
    const elicit = vi
      .fn()
      .mockRejectedValue(new Error('Client does not support form elicitation.'));
    const { server, handlers } = captureTools(elicit);
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    const res = await handlers.send_email({
      account: 'default',
      to: ['r@example.com'],
      subject: 'Hi',
      body: 'Body',
    });

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/not sent/i);
  });

  it('gates reply_email and forward_email too (decline blocks both)', async () => {
    const elicit = vi.fn().mockResolvedValue({ action: 'decline' });
    const { server, handlers } = captureTools(elicit);
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    await handlers.reply_email({ account: 'default', emailId: '1', mailbox: 'INBOX', body: 'R' });
    await handlers.forward_email({
      account: 'default',
      emailId: '1',
      mailbox: 'INBOX',
      to: ['r@example.com'],
    });

    expect(smtp.replyToEmail).not.toHaveBeenCalled();
    expect(smtp.forwardEmail).not.toHaveBeenCalled();
    expect(elicit).toHaveBeenCalledTimes(2);
  });

  it('when approval is off (default), does not elicit and sends normally', async () => {
    delete process.env.MCP_EMAIL_SEND_APPROVAL;
    const elicit = vi.fn();
    const { server, handlers } = captureTools(elicit);
    const smtp = makeSmtp();
    registerSendTools(server, smtp as unknown as SmtpService);

    await handlers.send_email({ account: 'default', to: ['r@example.com'], subject: 'Hi', body: 'B' });

    expect(elicit).not.toHaveBeenCalled();
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
  });
});
