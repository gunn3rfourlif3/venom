/* The one place that sends a WhatsApp message.
 *
 * Extracted because two callers need it - the webhook acknowledging a
 * marshal's report, and the alert engine interrupting the command centre -
 * and two copies of an API call is two places to fix a credential change.
 *
 * SERVICE WINDOW. These are plain text messages, which Meta permits only
 * inside the 24-hour window opened by the recipient messaging us. Outside
 * it an approved template is required. For acknowledgements that is always
 * satisfied, because the marshal has just written. For alerts it is not
 * guaranteed, and the failure is reported rather than swallowed so the
 * board can show that an alert was raised and not delivered.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface SendResult {
  ok: boolean;
  error?: string;
}

export function isConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export async function sendText(to: string, body: string): Promise<SendResult> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    return { ok: false, error: 'WhatsApp sending is not configured' };
  }

  try {
    const response = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body, preview_url: false },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) return { ok: true };

    // Meta's errors are informative and worth keeping: error 131047 is the
    // closed service window, which is a procedure problem rather than a bug
    // and reads very differently in a log than "HTTP 400".
    const detail = await response.json().catch(() => null) as
      { error?: { message?: string; code?: number } } | null;
    const message = detail?.error?.message ?? `HTTP ${response.status}`;
    const code = detail?.error?.code;
    return {
      ok: false,
      error: code === 131047
        ? `${message} (the recipient's 24-hour window is closed; they must message the number first)`
        : message,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
