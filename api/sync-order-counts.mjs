// api/sync-order-counts.js  —  bizapp-v2 (Vercel)
// Spotted Cod: nightly ORDER_COUNT sync, Square (source of truth) -> Brevo.
// Design: RECOMPUTE, never increment. Self-heals on the customer's next visit.

const SQUARE = "https://connect.squareup.com/v2";
const BREVO = "https://api.brevo.com/v3";

// Wavell Heights only.
const LOCATION_IDS = ["6ZQJ7VAW6MQMP"];

// Brevo "Main List".
const MAIN_LIST_ID = 6;

const sq = (path, init = {}) =>
  fetch(`${SQUARE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2025-01-23",
      ...init.headers,
    },
  });

const brevo = (path, init = {}) =>
  fetch(`${BREVO}${path}`, {
    ...init,
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Customer IDs on completed payments in the window (all pages).
async function recentCustomerIds(sinceISO) {
  const ids = new Set();
  for (const loc of LOCATION_IDS) {
    let cursor;
    do {
      const qs = new URLSearchParams({
        begin_time: sinceISO,
        location_id: loc,
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      const res = await sq(`/payments?${qs}`);
      if (!res.ok) throw new Error(`Square payments ${res.status}`);
      const body = await res.json();
      for (const p of body.payments ?? []) {
        if (p.status === "COMPLETED" && p.customer_id) ids.add(p.customer_id);
      }
      cursor = body.cursor;
    } while (cursor);
  }
  return [...ids];
}

// 2. Customer -> { email, id }. Square merges duplicate customer records (e.g. a
// separate in-person and online record for the same person). After a merge, an
// old payment's customer_id still resolves via GET, but the record returned is
// the SURVIVING one, whose id differs from the id requested. Counting orders
// against the stale id returns zero, so we return the current id too and callers
// must use it. No email means nothing to sync.
async function resolveCustomer(customerId) {
  const res = await sq(`/customers/${customerId}`);
  if (!res.ok) return null;
  const { customer } = await res.json();
  const email = customer?.email_address?.toLowerCase() || null;
  if (!email) return null;
  return { email, id: customer?.id || customerId };
}

// 3. Lifetime completed-order count for one customer.
async function lifetimeOrderCount(customerId) {
  let count = 0;
  let cursor;
  do {
    const res = await sq(`/orders/search`, {
      method: "POST",
      body: JSON.stringify({
        location_ids: LOCATION_IDS,
        limit: 100,
        cursor,
        query: {
          filter: {
            customer_filter: { customer_ids: [customerId] },
            state_filter: { states: ["COMPLETED"] },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Square orders ${res.status}`);
    const body = await res.json();
    count += (body.orders ?? []).length;
    cursor = body.cursor;
  } while (cursor);
  return count;
}

// 4. Write the recomputed truth to Brevo (creates or updates, adds to Main List).
// listIds is additive on both create and update — replaces the "customer order
// -> update contact list" Zapier automation this cron already runs alongside.
async function writeBrevo(email, extId, orderCount) {
  const res = await brevo(`/contacts`, {
    method: "POST",
    body: JSON.stringify({
      email,
      updateEnabled: true,
      listIds: [MAIN_LIST_ID],
      attributes: {
        ORDER_COUNT: orderCount,
        LAST_VISIT: new Date().toISOString().slice(0, 10),
        EXT_ID: extId,
      },
    }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`Brevo ${res.status}`);
}

export default async function handler(req, res) {
  // Vercel cron sends a signed header; manual runs need ?key=SYNC_SECRET.
  const isCron = Boolean(req.headers["x-vercel-cron"]);
  const keyOk = req.query.key && req.query.key === process.env.SYNC_SECRET;
  if (!isCron && !keyOk) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const days = Math.min(Number(req.query.days) || 2, 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const summary = {
    window_days: days,
    trigger: isCron ? "cron" : "manual",
    customers_seen: 0,
    updated: 0,
    merged_ids_resolved: 0,
    no_email: 0,
    errors: [],
  };

  try {
    const customerIds = await recentCustomerIds(since);
    summary.customers_seen = customerIds.length;

    for (const id of customerIds) {
      try {
        const resolved = await resolveCustomer(id);
        if (!resolved) {
          summary.no_email++;
          continue;
        }
        // Use the SURVIVING id from the resolved record — not the payment's id,
        // which may be stale after a Square merge — for both the order count and
        // the EXT_ID written to Brevo, so a merged contact self-heals.
        const currentId = resolved.id;
        if (currentId !== id) summary.merged_ids_resolved++;
        const count = await lifetimeOrderCount(currentId);
        await writeBrevo(resolved.email, currentId, count);
        summary.updated++;
        await sleep(120);
      } catch (e) {
        summary.errors.push(`${id}: ${e.message}`);
      }
    }
  } catch (e) {
    summary.errors.push(`fatal: ${e.message}`);
    console.error("sync-order-counts fatal", e);
    return res.status(500).json(summary);
  }

  console.log("sync-order-counts", JSON.stringify(summary));
  return res.status(200).json(summary);
}
