import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

// --- Disable Next.js body parsing (Stripe needs the raw body for signature verification) ---
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    // Lazy init — Stripe env vars only exist on Vercel, not locally
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
        apiVersion: "2026-02-25.clover",
    });
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
    // 1. Read the raw body and Stripe signature header
    const rawBody = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
        console.error("[lVl] Stripe webhook: Missing signature header.");
        return NextResponse.json({ error: "Missing signature" }, { status: 400 });
    }

    // 2. Verify the webhook signature (rejects forged requests)
    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[lVl] Stripe webhook signature verification failed: ${message}`);
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // 3. Handle the event
    console.log(`[lVl] Stripe webhook received: ${event.type}`);

    if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;

        const customerEmail = session.customer_details?.email || "unknown";
        const customerName = session.customer_details?.name || "unknown";
        const amountPaid = session.amount_total
            ? `$${(session.amount_total / 100).toFixed(2)}`
            : "unknown";
        const sessionId = session.id;

        console.log("================================================");
        console.log("[lVl] NEW PAYMENT RECEIVED");
        console.log(`[lVl] Customer Name:  ${customerName}`);
        console.log(`[lVl] Customer Email: ${customerEmail}`);
        console.log(`[lVl] Amount Paid:    ${amountPaid}`);
        console.log(`[lVl] Session ID:     ${sessionId}`);
        console.log("================================================");

        // -------------------------------------------------------
        // PHASE 2 HOOK: Railway API provisioning will go here.
        // -------------------------------------------------------

        // -------------------------------------------------------
        // PHASE 3 HOOK: Email delivery will go here.
        // -------------------------------------------------------
    } else {
        console.log(`[lVl] Unhandled event type: ${event.type}. Ignoring.`);
    }

    // 4. Acknowledge receipt — Stripe retries if it doesn't get a 200
    return NextResponse.json({ received: true }, { status: 200 });
}
