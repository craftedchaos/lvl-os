// Subscribes a landing-page lead to the Mailchimp audience.
//
// Uses the audience's embedded-form endpoint (the same one the daspeed site
// posts to) rather than the Marketing API, so no API key is required. The
// request runs server-side to avoid CORS and to keep the SOURCE merge field
// authoritative: every lead from this site is tagged "lvl".
//
// Config can be overridden with env vars; the defaults are the public values
// from the audience's embedded form and are not secrets.

const DC = process.env.MAILCHIMP_DC || "us13";
const USER_ID = process.env.MAILCHIMP_USER_ID || "b031fb2dd6aa05132cbdec517";
const LIST_ID = process.env.MAILCHIMP_LIST_ID || "dc329874d9";
const FORM_ID = process.env.MAILCHIMP_FORM_ID || "00b9fbe1f0";

const SOURCE = "lvl";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HONEYPOT = `b_${USER_ID}_${LIST_ID}`;

function field(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function fail(error: string, status = 400) {
  return Response.json({ ok: false, error }, { status });
}

// Mailchimp's post-json endpoint normally returns bare JSON, but some
// configurations wrap it in a JSONP callback: callback({...});
function parseResponse(raw: string): { result?: string; msg?: string } {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("(");
  const candidate =
    start === 0 ? trimmed.slice(1, trimmed.lastIndexOf(")")) : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid request.");
  }

  const name = field(body.name, 100);
  const email = field(body.email, 254);
  const company = field(body.company, 200);
  const spend = field(body.spend, 100);
  const need = field(body.need, 100);
  const message = field(body.message, 2000);
  const honeypot = field(body.honeypot, 200);

  if (!EMAIL_PATTERN.test(email)) {
    return fail("Please enter a valid work email.");
  }
  if (!name || !company || !spend || !need) {
    return fail("Please fill in the required fields.");
  }
  if (honeypot) {
    // Quietly accept so bots do not learn the trap; no request is sent.
    return Response.json({ ok: true });
  }

  // Mailchimp has first/last name merge fields; the form collects one name.
  const parts = name.split(/\s+/);
  const firstName = parts.shift() || name;
  const lastName = parts.join(" ");

  // The form's qualifiers are folded into the single MESSAGE merge field so
  // nothing is lost without adding merge fields to the audience.
  const messageBody = [
    `Company: ${company}`,
    `Monthly cloud / AI spend: ${spend}`,
    `Where the work gets harder: ${need}`,
    message ? `\n${message}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const form = new URLSearchParams();
  form.set("EMAIL", email);
  form.set("FNAME", firstName);
  if (lastName) form.set("LNAME", lastName);
  form.set("MESSAGE", messageBody);
  form.set("SOURCE", SOURCE);
  form.set(HONEYPOT, "");

  const endpoint =
    `https://gmail.${DC}.list-manage.com/subscribe/post-json` +
    `?u=${encodeURIComponent(USER_ID)}` +
    `&id=${encodeURIComponent(LIST_ID)}` +
    `&f_id=${encodeURIComponent(FORM_ID)}` +
    `&c=?`;

  let raw: string;
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    raw = await upstream.text();
  } catch {
    return fail(
      "We could not reach the mailing list just now. Please try again, or email hello@stblvl.com.",
      502,
    );
  }

  const parsed = parseResponse(raw);

  if (parsed.result === "success") {
    return Response.json({ ok: true });
  }

  const upstreamMessage = parsed.msg || "";

  // A returning lead is still a lead: treat "already subscribed" as success.
  if (/already subscribed/i.test(upstreamMessage)) {
    return Response.json({ ok: true, alreadySubscribed: true });
  }

  // Mailchimp rejects disposable/placeholder domains ("looks fake or invalid").
  if (/fake or invalid|invalid email/i.test(upstreamMessage)) {
    return fail("Please enter a real work email.", 422);
  }

  return fail(
    "We could not add you to the list. Please try again, or email hello@stblvl.com.",
    502,
  );
}
