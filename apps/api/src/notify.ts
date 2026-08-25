// ----------------------------------------------------------------
// Lead notifications
//
// One outbound webhook per captured lead, in one of three body shapes.
// This is the whole of the "integrations" story for now: a generic JSON
// POST covers custom CRMs, and Slack and Teams are the same POST with
// the body those products expect.
//
// THREE RULES HOLD THROUGHOUT, and each is here because the alternative
// costs a visitor something:
//
//   * this never throws. A lead is already safely in Postgres by the
//     time anything here runs, so a webhook failure is a missed
//     notification, not lost data, and must not surface anywhere near
//     the chat response;
//   * it is called from waitUntil, never from the awaited persist path.
//     A third party's latency is not the visitor's to pay;
//   * it does not retry. A retry against an endpoint with no
//     idempotency key posts the lead into the channel twice, and two
//     Slack messages for one lead is worse than none.
//
// The URL is a credential — see redactBotSecrets in src/index.ts and
// the note on webhook_url in supabase/010.
// ----------------------------------------------------------------
import type { LeadConfig, WebhookFormat } from './types';

/** Past this a third party is not going to answer at all. */
const TIMEOUT_MS = 5_000;

export interface LeadNotification {
  botName: string;
  businessName: string;
  /** name / email / phone / inquiry / company, already validated. */
  lead: {
    name: string;
    email: string;
    phone: string | null;
    inquiry: string | null;
    company: string | null;
  };
  sessionId: string;
  tag: string | null;
  consentGiven: boolean | null;
  bookingUrl: string | null;
  capturedAt: string;
}

/**
 * The host, for showing "Posting to hooks.slack.com" in a settings
 * screen that is never given the URL itself. Returns null rather than
 * throwing on a malformed stored value — a bad row should not take the
 * settings page down.
 */
export function webhookHost(url: string | undefined | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/** Slack reserves these three in message text. */
const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');


function factList(n: LeadNotification): [string, string][] {
  const facts: [string, string][] = [
    ['Name', n.lead.name],
    ['Email', n.lead.email],
  ];
  if (n.lead.phone !== null)   facts.push(['Phone', n.lead.phone]);
  if (n.lead.company !== null) facts.push(['Company', n.lead.company]);
  if (n.lead.inquiry !== null) facts.push(['Inquiry', n.lead.inquiry]);
  if (n.tag)                   facts.push(['Tag', n.tag]);
  return facts;
}

/**
 * The body for one format.
 *
 * Exported separately from the dispatch so the shapes can be tested
 * without a network — which is the only way to test them, since the
 * three receiving products cannot be stood up in CI.
 */
export function webhookBody(format: WebhookFormat, n: LeadNotification): unknown {
  const facts = factList(n);

  if (format === 'slack') {
    const summary = `New lead for ${n.businessName}: ${n.lead.name}`;
    const body = facts.map(([k, v]) => `*${slackEscape(k)}:* ${slackEscape(v)}`).join('\n');
    return {
      // `text` is both the notification preview and the fallback for
      // any client that does not render blocks.
      text: summary,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `New lead — ${n.businessName}`.slice(0, 150) } },
        { type: 'section', text: { type: 'mrkdwn', text: body } },
        ...(n.bookingUrl
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Booking link offered: ${n.bookingUrl}` }] }]
          : []),
      ],
    };
  }

  if (format === 'teams') {
    // An Adaptive Card wrapped for a Power Automate "When a Teams
    // webhook request is received" flow. NOT the older MessageCard /
    // "@type: MessageCard" shape — Microsoft retired Office 365
    // connectors, and a MessageCard posted to a Workflows URL is
    // accepted and then renders as nothing.
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `New lead — ${n.businessName}` },
            { type: 'FactSet', facts: facts.map(([title, value]) => ({ title, value })) },
            ...(n.bookingUrl
              ? [{ type: 'TextBlock', isSubtle: true, wrap: true, text: `Booking link offered: ${n.bookingUrl}` }]
              : []),
          ],
        },
      }],
    };
  }

  // Generic JSON — the shape a custom CRM endpoint receives. Flat,
  // fully populated (nulls included rather than omitted, so a consumer
  // can map fields positionally), and versioned by `event` so a later
  // change has somewhere to go.
  return {
    event: 'lead.created',
    captured_at: n.capturedAt,
    bot: { name: n.botName, business_name: n.businessName },
    lead: {
      name: n.lead.name,
      email: n.lead.email,
      phone: n.lead.phone,
      company: n.lead.company,
      inquiry: n.lead.inquiry,
      tag: n.tag,
      // See supabase/010: this means the bot was told to ask, not that
      // the visitor accepted. Named consistently with the column so the
      // meaning travels with it.
      consent_given: n.consentGiven,
      session_id: n.sessionId,
    },
    booking_url: n.bookingUrl,
  };
}

const htmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The notification email. Never throws.
 *
 * `reply_to` is the lead's own address, which is the whole ergonomic
 * point: hitting Reply in the inbox answers the visitor directly
 * instead of bouncing off a no-reply sender.
 *
 * Recipients go in `bcc` with the From address as the only `to`. They
 * are colleagues on a distribution list, not a thread — putting five
 * addresses in `to` publishes each of them to the other four, and a
 * reply-all then goes to the lead plus the whole team.
 */
async function emailLead(
  recipients: string[],
  auth: { apiKey: string; from: string },
  n: LeadNotification,
): Promise<void> {
  const facts = factList(n);
  const subject = `New lead — ${n.lead.name}${n.tag ? ` (${n.tag})` : ''}`;

  const text = [
    `New lead for ${n.businessName}`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(n.bookingUrl ? ['', `Booking link offered: ${n.bookingUrl}`] : []),
  ].join('\n');

  const html = [
    `<h2 style="font:600 18px system-ui,sans-serif;margin:0 0 16px">New lead for ${htmlEscape(n.businessName)}</h2>`,
    '<table style="font:14px system-ui,sans-serif;border-collapse:collapse">',
    ...facts.map(([k, v]) =>
      `<tr><td style="padding:4px 16px 4px 0;color:#666;vertical-align:top">${htmlEscape(k)}</td>`
      + `<td style="padding:4px 0">${htmlEscape(v)}</td></tr>`),
    '</table>',
    ...(n.bookingUrl
      ? [`<p style="font:13px system-ui,sans-serif;color:#666">Booking link offered: ${htmlEscape(n.bookingUrl)}</p>`]
      : []),
  ].join('');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.apiKey}`,
      },
      body: JSON.stringify({
        from: auth.from,
        to: [auth.from],
        bcc: recipients,
        reply_to: n.lead.email,
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // An unverified sending domain is by far the most common failure
      // here and it presents as a 403 with the reason in the body, so
      // the body is worth the extra read.
      console.error(`[notify] email ${res.status}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[notify] email failed (non-fatal):', err);
  }
}

/**
 * Fire the webhook, if one is configured. Never throws.
 *
 * `keepalive` is deliberately not set: this runs inside waitUntil,
 * which already holds the Worker open for exactly as long as the
 * request needs.
 */
async function callWebhook(cfg: LeadConfig, n: LeadNotification): Promise<void> {
  const url = cfg.webhook_url;
  if (!url) return;

  const format: WebhookFormat = cfg.webhook_format ?? 'json';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Identifies the caller in a customer's access log without
        // revealing which bot or org — the body already says that, to
        // someone who is entitled to it.
        'user-agent': 'ConverseKit-Webhook/1.0',
      },
      body: JSON.stringify(webhookBody(format, n)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // Body is read and truncated because Slack answers a bad payload
      // with 200-less-than-helpful text like "invalid_blocks", and
      // without it the log says only "400".
      const detail = await res.text().catch(() => '');
      console.error(`[notify] webhook ${res.status} from ${webhookHost(url)}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[notify] webhook to ${webhookHost(url)} failed (non-fatal):`, err);
  }
}

/**
 * Every notification this lead should produce. Never throws.
 *
 * The two channels run concurrently and independently: a tenant who has
 * both configured should not lose the email because Slack was down, and
 * neither is worth adding latency to the other. Both swallow their own
 * failures, so `allSettled` is not needed to keep this safe — it is
 * `all` over two promises that already cannot reject.
 *
 * @param email The deployment's Resend credentials, when it has them.
 *   Absent means the email half is off — recipients stay stored and
 *   simply nothing is sent, which is how every optional binding in this
 *   codebase behaves.
 */
export async function notifyLead(
  cfg: LeadConfig,
  n: LeadNotification,
  email?: { apiKey?: string; from?: string },
): Promise<void> {
  const recipients = cfg.email_recipients ?? [];
  const canEmail = recipients.length > 0 && !!email?.apiKey && !!email.from;

  await Promise.all([
    callWebhook(cfg, n),
    canEmail
      ? emailLead(recipients, { apiKey: email!.apiKey!, from: email!.from! }, n)
      : Promise.resolve(),
  ]);
}
