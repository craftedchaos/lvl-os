import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

// --- Disable Next.js body parsing (Stripe needs the raw body for signature verification) ---
export const dynamic = "force-dynamic";

// ============================================================
// RAILWAY GraphQL API LAYER
// ============================================================

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

interface RailwayResponse {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
}

async function railwayQuery(query: string, variables: Record<string, unknown> = {}): Promise<RailwayResponse> {
    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) throw new Error("RAILWAY_API_TOKEN is not set.");

    const res = await fetch(RAILWAY_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
    });

    const json = await res.json();
    if (json.errors) {
        console.error("[lVl] Railway API error:", JSON.stringify(json.errors));
        throw new Error(`Railway API: ${json.errors[0]?.message}`);
    }
    return json;
}

// --- Step 1: Create a new Railway project ---
async function createProject(name: string): Promise<{ projectId: string; environmentId: string }> {
    const res = await railwayQuery(`
        mutation($input: ProjectCreateInput!) {
            projectCreate(input: $input) {
                id
                environments {
                    edges {
                        node {
                            id
                            name
                        }
                    }
                }
            }
        }
    `, {
        input: { name },
    });

    const project = (res.data as any).projectCreate;
    const productionEnv = project.environments.edges.find(
        (e: any) => e.node.name === "production"
    );
    const environmentId = productionEnv?.node?.id || project.environments.edges[0]?.node?.id;

    console.log(`[lVl] Railway: Project created — ${project.id} (env: ${environmentId})`);
    return { projectId: project.id, environmentId };
}

// --- Step 2: Create a service linked to the GitHub repo ---
async function createService(projectId: string): Promise<string> {
    const repo = process.env.RAILWAY_GITHUB_REPO || "craftedchaos/lvl-os";

    const res = await railwayQuery(`
        mutation($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
                id
            }
        }
    `, {
        input: {
            projectId,
            source: { github: { repo, branch: "main" } },
        },
    });

    const serviceId = (res.data as any).serviceCreate.id;
    console.log(`[lVl] Railway: Service created — ${serviceId} (repo: ${repo})`);
    return serviceId;
}

// --- Step 3: Inject environment variables ---
async function setVariable(
    projectId: string,
    serviceId: string,
    environmentId: string,
    name: string,
    value: string
): Promise<void> {
    await railwayQuery(`
        mutation($input: VariableUpsertInput!) {
            variableUpsert(input: $input)
        }
    `, {
        input: { projectId, serviceId, environmentId, name, value },
    });
    console.log(`[lVl] Railway: Variable set — ${name}`);
}

async function injectTenantVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
    tier: string = "monthly"
): Promise<void> {
    const tenantKey = process.env.TENANT_OPENAI_KEY;
    if (!tenantKey) throw new Error("TENANT_OPENAI_KEY is not set.");

    const vars: Record<string, string> = {
        INSTANCE_MODE: "tenant",
        NEXT_PUBLIC_INSTANCE_MODE: "tenant",
        TENANT_TYPE: "b2b",
        OPENAI_API_KEY: tenantKey,
        DATA_DIR: "/app/data",
        TENANT_TIER: tier,
    };

    for (const [name, value] of Object.entries(vars)) {
        await setVariable(projectId, serviceId, environmentId, name, value);
    }
    console.log("[lVl] Railway: All tenant variables injected.");
}

// --- Step 4: Create and mount a persistent volume ---
// Schema-verified via introspection. Two-step: create, then explicitly bind.
// Graceful fallback: if volume fails, provisioning continues without persistent storage.
async function createVolume(
    projectId: string,
    serviceId: string,
    environmentId: string
): Promise<string | null> {
    try {
        // Step 4a: Create volume (projectId + mountPath are required, serviceId + environmentId optional)
        const createRes = await railwayQuery(`
            mutation($input: VolumeCreateInput!) {
                volumeCreate(input: $input) {
                    id
                }
            }
        `, {
            input: {
                projectId,
                mountPath: "/app/data",
                serviceId,
                environmentId,
            },
        });

        const volumeId = (createRes.data as any).volumeCreate.id;
        console.log(`[lVl] Railway: Volume created — ${volumeId}`);

        // Step 4b: Explicitly bind volume to service instance
        // Schema: volumeId (top-level, required), environmentId (top-level, optional),
        //         input: { serviceId, mountPath, state } (all optional)
        await railwayQuery(`
            mutation($volumeId: String!, $environmentId: String, $input: VolumeInstanceUpdateInput!) {
                volumeInstanceUpdate(volumeId: $volumeId, environmentId: $environmentId, input: $input) {
                    id
                }
            }
        `, {
            volumeId,
            environmentId,
            input: {
                serviceId,
                mountPath: "/app/data",
            },
        });

        console.log("[lVl] Railway: Volume bound to service at /app/data");
        return volumeId;
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[lVl] Railway: Volume creation/binding failed (non-fatal): ${message}`);
        console.log("[lVl] Railway: Proceeding without persistent volume. Data will not survive redeploys.");
        return null;
    }
}

// --- Step 5: Generate a Railway domain ---
async function createDomain(
    serviceId: string,
    environmentId: string
): Promise<string> {
    const res = await railwayQuery(`
        mutation($input: ServiceDomainCreateInput!) {
            serviceDomainCreate(input: $input) {
                domain
            }
        }
    `, {
        input: { serviceId, environmentId },
    });

    const domain = (res.data as any).serviceDomainCreate.domain;
    console.log(`[lVl] Railway: Domain assigned — https://${domain}`);
    return domain;
}

// --- Sanitize customer name for project naming ---
function sanitizeProjectName(name: string, email: string, sessionId: string): string {
    // Try name first, fall back to email prefix
    const raw = name !== "unknown" ? name : email.split("@")[0];
    const suffix = sessionId.slice(-4); // last 4 chars of Stripe session ID
    const base = raw
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 25);                 // shortened to leave room for suffix
    return `lvl-${base}-${suffix}`;
}

// ============================================================
// FULL PROVISIONING PIPELINE
// ============================================================

async function provisionTenantInstance(customerName: string, customerEmail: string, sessionId: string, tier: string = "monthly"): Promise<string> {
    const projectName = sanitizeProjectName(customerName, customerEmail, sessionId);
    console.log(`[lVl] Provisioning tenant: ${projectName} for ${customerEmail}`);

    // Step 1: Create project
    const { projectId, environmentId } = await createProject(projectName);

    // Step 2: Create service (linked to GitHub repo — auto-deploys)
    const serviceId = await createService(projectId);

    // Step 3: Inject environment variables
    await injectTenantVariables(projectId, serviceId, environmentId, tier);

    // Step 4: Create and mount persistent volume
    await createVolume(projectId, serviceId, environmentId);

    // Step 5: Assign a Railway domain
    const domain = await createDomain(serviceId, environmentId);

    console.log("================================================");
    console.log("[lVl] TENANT PROVISIONING COMPLETE");
    console.log(`[lVl] Project:  ${projectName}`);
    console.log(`[lVl] Customer: ${customerEmail}`);
    console.log(`[lVl] URL:      https://${domain}`);
    console.log("================================================");

    return domain;
}

// ============================================================
// EMAIL DELIVERY (Resend)
// ============================================================

async function sendDeploymentEmail(customerEmail: string, customerName: string, domain: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
    if (!apiKey) throw new Error("RESEND_API_KEY is not set.");

    const emailBody = `<p>${customerName},</p>

<p>your lVl workspace is set up and ready.<br>
this is where you take what's in your head<br>
and turn it into something you can actually use.</p>

<p><strong>start here</strong><br>
open your workspace:<br>
<a href="https://${domain}">https://${domain}</a><br>
bookmark it. you'll come back to it.</p>

<p><strong>what to expect</strong><br>
when you enter, you'll be guided through a short set of questions.<br>
take your time with it.<br>
the more specific you are about what's not working,<br>
the more useful the output will be.</p>

<p><strong>how to use it</strong><br>
if things feel messy, just start writing.<br>
it will help you sort it.<br>
if something feels too generic, say so.<br>
add detail. tighten it.<br>
you don't need to "use it correctly."<br>
you just need to start.</p>

<p><strong>if you get stuck</strong><br>
refresh the page<br>
or just ask it where to go next<br>
you won't lose your work.</p>

<p><strong>one thing to keep in mind</strong><br>
this is a tool for thinking and structuring.<br>
read through anything it generates before using it in the real world.<br>
use your judgment.</p>

<p>lVl s p a c e to begin —|••</p>`;

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            from: fromEmail,
            to: customerEmail,
            subject: "Your lVl OS instance is live.",
            html: emailBody,
        }),
    });

    if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`Resend API ${res.status}: ${errorBody}`);
    }

    console.log(`[lVl] Deployment email sent to ${customerEmail}`);
}

// ============================================================
// STRIPE WEBHOOK HANDLER
// ============================================================

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

        const tier = session.mode === "payment" ? "sovereign" : "monthly";
        console.log(`[lVl] Tier: ${tier}`);

        // --- PHASE 2: Railway Provisioning ---
        try {
            const domain = await provisionTenantInstance(customerName, customerEmail, sessionId, tier);
            console.log(`[lVl] Tenant live at: https://${domain}`);

            // --- PHASE 3: Email Delivery ---
            try {
                await sendDeploymentEmail(customerEmail, customerName || "Builder", domain);
            } catch (emailErr) {
                const emailMsg = emailErr instanceof Error ? emailErr.message : "Unknown error";
                console.error(`[lVl] EMAIL FAILED for ${customerEmail}: ${emailMsg}`);
                // Email failure does not block the webhook response.
                // The tenant is live — customer URL can be sent manually if needed.
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            console.error(`[lVl] PROVISIONING FAILED for ${customerEmail}: ${message}`);
            // NOTE: We still return 200 to Stripe — the payment succeeded.
            // Provisioning failure is an internal issue to resolve manually.
        }
    } else if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        try {
            const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
            if (customer.deleted) throw new Error("Customer deleted in Stripe.");

            const email = customer.email || "unknown";
            const name = customer.name || "unknown";
            // Build the project name prefix (without session suffix) for prefix matching
            const rawName = name !== "unknown" ? name : email.split("@")[0];
            const namePrefix = "lvl-" + rawName
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 25);
            console.log(`[lVl] CANCELLATION RECEIVED for ${email} (searching for projects starting with: ${namePrefix})`);

            // Fetch all projects to find the matching ID
            const res = await railwayQuery(`
                query {
                    projects {
                        edges {
                            node {
                                id
                                name
                            }
                        }
                    }
                }
            `);

            const projects = (res.data as any).projects.edges;
            const targetProject = projects.find((p: any) => p.node.name.startsWith(namePrefix));

            if (targetProject) {
                await railwayQuery(`
                    mutation($id: String!) {
                        projectDelete(id: $id)
                    }
                `, { id: targetProject.node.id });
                console.log(`[lVl] Railway: Project teardown complete (${targetProject.node.name})`);
            } else {
                console.log(`[lVl] Railway: No project matching prefix ${namePrefix} found for teardown.`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            console.error(`[lVl] CANCELLATION TEARDOWN FAILED: ${message}`);
            // Note: Still returns 200 so Stripe knows we received the event.
        }
    } else {
        console.log(`[lVl] Unhandled event type: ${event.type}. Ignoring.`);
    }

    // 4. Acknowledge receipt — Stripe retries if it doesn't get a 200
    return NextResponse.json({ received: true }, { status: 200 });
}
