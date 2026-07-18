/**
 * Human-in-the-loop approval for outgoing email.
 *
 * When `MCP_EMAIL_SEND_APPROVAL=elicit`, the send-side tools ask the connected
 * client to approve each outgoing message via MCP elicitation BEFORE it is sent.
 * The client renders it as an approve/deny prompt (e.g. Telegram buttons) showing
 * the recipients/subject/body. Fail-closed: any non-accept outcome
 * (decline/cancel/timeout) or a client that cannot be elicited blocks the send.
 *
 * Client constraints (verified against Hermes + MCP SDK 1.26.0):
 *   - mode MUST be 'form' (url mode is hard-declined by the client).
 *   - requestedSchema MUST have no required properties: the client approves with
 *     action:'accept' and empty content:{}, so a required field would fail schema
 *     validation and block an approved send. Treat action==='accept' as approval.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function sendApprovalEnabled(): boolean {
  return process.env.MCP_EMAIL_SEND_APPROVAL === 'elicit';
}

/**
 * How long to wait for the human to approve, in ms. The MCP request default is
 * only 60s — far too short for a person to review and tap Approve — so we give a
 * generous window (default 10 min), overridable via MCP_EMAIL_APPROVAL_TIMEOUT_MS.
 */
export function approvalTimeoutMs(): number {
  const v = Number.parseInt(process.env.MCP_EMAIL_APPROVAL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

export interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
}

/**
 * Ask the client to approve an outgoing email. Returns {approved:true} when
 * approval is disabled or the user accepts; otherwise {approved:false} with a
 * human-readable reason. Never throws.
 */
export async function requestSendApproval(
  server: McpServer,
  action: string,
  details: string,
): Promise<ApprovalOutcome> {
  if (!sendApprovalEnabled()) return { approved: true };

  try {
    const result = await server.server.elicitInput(
      {
        mode: 'form',
        message: `Approve ${action}?\n\n${details}`,
        requestedSchema: { type: 'object', properties: {} },
      },
      { timeout: approvalTimeoutMs(), resetTimeoutOnProgress: false },
    );
    if (result.action === 'accept') return { approved: true };
    const verb = result.action === 'decline' ? 'declined' : 'cancelled';
    return { approved: false, reason: `Send ${verb} — email was NOT sent.` };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return {
      approved: false,
      reason:
        `Could not obtain send approval (${m}) — email was NOT sent. ` +
        `Approval prompts only appear on chat platforms like Telegram; ` +
        `voice or API sessions cannot approve.`,
    };
  }
}

/** Build a To/Cc/Subject/body-preview block for the approval prompt. */
export function emailSummary(fields: {
  account: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  note?: string;
}): string {
  const lines: string[] = [`From account: ${fields.account}`];
  if (fields.to?.length) lines.push(`To: ${fields.to.join(', ')}`);
  if (fields.cc?.length) lines.push(`Cc: ${fields.cc.join(', ')}`);
  if (fields.subject) lines.push(`Subject: ${fields.subject}`);
  if (fields.note) lines.push(fields.note);
  if (fields.body) {
    const preview =
      fields.body.length > 600 ? `${fields.body.slice(0, 600)} …[truncated]` : fields.body;
    lines.push('', preview);
  }
  return lines.join('\n');
}
