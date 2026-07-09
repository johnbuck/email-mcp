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
function captureTools() {
  const handlers: Record<string, ToolHandler> = {};
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, _ann: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
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
