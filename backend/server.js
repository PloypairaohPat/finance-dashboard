// ─────────────────────────────────────────────────────────────────
//  server.js  —  Plaid Integration Backend
// ─────────────────────────────────────────────────────────────────

// ── 1. dotenv MUST be first — everything below reads process.env ──
require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const { PlaidApi, PlaidEnvironments, Configuration } = require("plaid");
const prisma               = require("./lib/prisma");
const { encrypt, decrypt } = require("./utils/encrypt");
const { syncTransactions } = require("./services/plaidSync");

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;

// ── 2. App setup — MUST come before routes ────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      "http://localhost:3000",
      /https:\/\/finance-dashboard.*\.vercel\.app$/,
    ];
    if (!origin || allowed.some(o => 
      typeof o === "string" ? o === origin : o.test(origin)
    )) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

// ── 3. Validate required env vars at startup ──────────────────────
const REQUIRED_ENV = [
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ENV",
  "DEFAULT_USER_ID",
  "ENCRYPTION_KEY",
];
REQUIRED_ENV.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
});

// ── 4. Plaid client ───────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET":    process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ─────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────

// ── POST /create_link_token ───────────────────────────────────────
app.post("/create_link_token", async (req, res) => {
  try {
    const userId = req.body.userId || DEFAULT_USER_ID;

    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: userId },
      client_name:   "My Finance App",
      products:      (process.env.PLAID_PRODUCTS || "transactions")
                       .split(",").map((p) => p.trim()),
      country_codes: (process.env.PLAID_COUNTRY_CODES || "US")
                       .split(",").map((c) => c.trim()),
      language: "en",
      webhook:  process.env.WEBHOOK_URL,
    });

    console.log(`✅ link_token created for user: ${userId}`);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("❌ /create_link_token error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── POST /exchange_public_token ───────────────────────────────────
// Re-link aware: if the user reconnects the same institution,
// the old item + accounts + transactions are replaced cleanly.
// This prevents duplicate account cards on repeated logins.
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body;

    // 1. Exchange public token for permanent access token
    const tokenResponse = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = tokenResponse.data;

    // 2. Encrypt before storing — never store plaintext in the DB
    const encryptedToken = encrypt(access_token);

    // 3. Get institution details
    const itemResponse  = await plaidClient.itemGet({ access_token });
    const institutionId = itemResponse.data.item.institution_id;

    let institutionName = null;
    if (institutionId) {
      const instResponse = await plaidClient.institutionsGetById({
        institution_id: institutionId,
        country_codes:  ["US"],
      });
      institutionName = instResponse.data.institution.name;
    }

    // 4. Check if user already has an item for this institution
    //    If so, delete it and all its linked data before creating fresh.
    //    Rule: one active PlaidItem per institution per user.
    const existingItem = await prisma.plaidItem.findFirst({
      where: { userId: DEFAULT_USER_ID, institutionId },
    });

    if (existingItem) {
      console.log(`🔄 Re-linking ${institutionName} — replacing existing item`);

      // Delete in order: transactions → accounts → item (foreign key order)
      const existingAccounts = await prisma.account.findMany({
        where: { plaidItemId: existingItem.id },
        select: { id: true },
      });
      const accountIds = existingAccounts.map((a) => a.id);

      await prisma.transaction.deleteMany({
        where: { accountId: { in: accountIds } },
      });
      await prisma.account.deleteMany({
        where: { plaidItemId: existingItem.id },
      });
      await prisma.plaidItem.delete({
        where: { id: existingItem.id },
      });

      console.log(`🗑  Removed old item + ${accountIds.length} accounts`);
    }

    // 5. Create fresh PlaidItem
    const plaidItem = await prisma.plaidItem.create({
      data: {
        userId:          DEFAULT_USER_ID,
        itemId:          item_id,
        accessToken:     encryptedToken,
        institutionId,
        institutionName,
      },
    });

    // 6. Fetch and persist accounts
    const accountsResponse = await plaidClient.accountsGet({ access_token });

    for (const acct of accountsResponse.data.accounts) {
      await prisma.account.upsert({
        where:  { plaidAccountId: acct.account_id },
        update: {
          userId:           DEFAULT_USER_ID,
          plaidItemId:      plaidItem.id,
          name:             acct.name,
          officialName:     acct.official_name ?? null,
          type:             acct.type,
          subtype:          acct.subtype ?? null,
          mask:             acct.mask ?? null,
          currentBalance:   acct.balances.current,
          availableBalance: acct.balances.available,
          isoCurrencyCode:  acct.balances.iso_currency_code ?? null,
},
        create: {
          userId:           DEFAULT_USER_ID,
          plaidItemId:      plaidItem.id,
          plaidAccountId:   acct.account_id,
          name:             acct.name,
          officialName:     acct.official_name              ?? null,
          type:             acct.type,
          subtype:          acct.subtype                    ?? null,
          mask:             acct.mask                       ?? null,
          currentBalance:   acct.balances.current,
          availableBalance: acct.balances.available,
          isoCurrencyCode:  acct.balances.iso_currency_code ?? null,
        },
      });
    }

    console.log(`✅ ${institutionName} connected — ${accountsResponse.data.accounts.length} accounts`);
    res.json({ success: true, institutionName });
  } catch (err) {
    console.error("❌ /exchange_public_token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── GET /accounts ─────────────────────────────────────────────────
app.get("/accounts", async (req, res) => {
  try {
    const accounts = await prisma.account.findMany({
      where:   { userId: DEFAULT_USER_ID },
      orderBy: { name: "asc" },
    });
    res.json({ accounts });
  } catch (err) {
    console.error("❌ /accounts error:", err.message);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// ── GET /categories ───────────────────────────────────────────────
app.get("/categories", async (req, res) => {
  try {
    const grouped = await prisma.transaction.groupBy({
      by: ["categoryPrimary"],
      where: {
        userId:   DEFAULT_USER_ID,
        deletedAt: null,
        pending:   false,
        amount:    { gt: 0 },
        categoryPrimary: {
          not:   null,
          notIn: ["TRANSFER_OUT", "TRANSFER_IN"],
        },
      },
      _sum:    { amount: true },
      orderBy: { _sum: { amount: "desc" } },
    });

    const categories = grouped.map((row) => ({
      name:  row.categoryPrimary,
      total: Number(row._sum.amount || 0),
    }));

    res.json({ categories });
  } catch (err) {
    console.error("❌ /categories error:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// ── GET /recurring ────────────────────────────────────────────────
// Uses Plaid's transactionsRecurringGet to identify subscriptions,
// bills, and income streams. Requires account IDs from the DB.
app.get("/recurring", async (req, res) => {
  try {
    const items = await prisma.plaidItem.findMany({
      where: { userId: DEFAULT_USER_ID },
      include: { accounts: true },
    });

    if (items.length === 0) {
      return res.json({ outflow: [], inflow: [], monthlyOutflow: 0 });
    }

    let allOutflow = [];
    let allInflow = [];

    for (const item of items) {
      const access_token = decrypt(item.accessToken);
      const account_ids = item.accounts.map((a) => a.plaidAccountId);

      if (account_ids.length === 0) continue;

      const response = await plaidClient.transactionsRecurringGet({
        access_token,
        account_ids,
      });

      const { outflow_streams, inflow_streams } = response.data;

      const outflow = outflow_streams
        .filter(
          (s) => s.status === "MATURE" || s.status === "EARLY_DETECTION"
        )
        .map((s) => ({
          merchantName: s.merchant_name || s.description,
          frequency: s.frequency,
          lastAmount: Math.abs(Number(s.last_amount?.amount ?? 0)),
          averageAmount: Math.abs(Number(s.average_amount?.amount ?? 0)),
          lastDate: s.last_date,
          status: s.status,
          category: s.personal_finance_category?.primary ?? null,
        }))
        .sort((a, b) => b.averageAmount - a.averageAmount);

      const inflow = inflow_streams
        .filter(
          (s) => s.status === "MATURE" || s.status === "EARLY_DETECTION"
        )
        .map((s) => ({
          merchantName: s.merchant_name || s.description,
          frequency: s.frequency,
          lastAmount: Math.abs(Number(s.last_amount?.amount ?? 0)),
          averageAmount: Math.abs(Number(s.average_amount?.amount ?? 0)),
          lastDate: s.last_date,
          status: s.status,
          category: s.personal_finance_category?.primary ?? null,
        }))
        .sort((a, b) => b.averageAmount - a.averageAmount);

      allOutflow = allOutflow.concat(outflow);
      allInflow = allInflow.concat(inflow);
    }

    const monthlyOutflow = allOutflow.reduce((sum, s) => {
      const monthly =
        s.frequency === "WEEKLY"
          ? s.averageAmount * 4.33
          : s.frequency === "BIWEEKLY"
          ? s.averageAmount * 2.17
          : s.frequency === "SEMI_MONTHLY"
          ? s.averageAmount * 2
          : s.frequency === "ANNUALLY"
          ? s.averageAmount / 12
          : s.averageAmount;

      return sum + monthly;
    }, 0);

    res.json({
      outflow: allOutflow,
      inflow: allInflow,
      monthlyOutflow: Math.round(monthlyOutflow * 100) / 100,
    });
  } catch (err) {
    console.error("❌ /recurring error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch recurring streams" });
  }
});

// ── GET /transactions ─────────────────────────────────────────────
app.get("/transactions", async (req, res) => {
  try {
    const items = await prisma.plaidItem.findMany({
      where: { userId: DEFAULT_USER_ID },
    });

    if (items.length === 0) return res.json({ transactions: [] });

    for (const item of items) {
      await syncTransactions(plaidClient, item.id);
    }

    const transactions = await prisma.transaction.findMany({
      where:   { userId: DEFAULT_USER_ID, deletedAt: null },
      orderBy: { date: "desc" },
      take:    200,
    });

    res.json({ transactions });
  } catch (err) {
    console.error("❌ /transactions error:", err.message);
    res.status(500).json({ error: "Failed to sync transactions" });
  }
});

// ── POST /webhook ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const { webhook_type, webhook_code, item_id } = req.body;
  console.log(`📨 Webhook: ${webhook_type}/${webhook_code} — item: ${item_id}`);
  res.json({ received: true });

  if (webhook_type === "TRANSACTIONS") {
    if (webhook_code === "SYNC_UPDATES_AVAILABLE") {
      try {
        const plaidItem = await prisma.plaidItem.findUnique({ where: { itemId: item_id } });
        if (!plaidItem) { console.warn(`⚠ Webhook for unknown item: ${item_id}`); return; }
        await syncTransactions(plaidClient, plaidItem.id);
      } catch (err) { console.error("❌ Webhook sync error:", err.message); }
    }
    if (webhook_code === "INITIAL_UPDATE" || webhook_code === "HISTORICAL_UPDATE") {
      try {
        const plaidItem = await prisma.plaidItem.findUnique({ where: { itemId: item_id } });
        if (plaidItem) await syncTransactions(plaidClient, plaidItem.id);
      } catch (err) { console.error("❌ Initial sync error:", err.message); }
    }
  }

  if (webhook_type === "ITEM" && webhook_code === "ERROR") {
    console.error(`❌ Plaid item error for ${item_id}:`, req.body.error);
  }
});

// ── GET /health ───────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", env: process.env.PLAID_ENV })
);

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Plaid backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.PLAID_ENV}`);
  console.log(`   Products:    ${process.env.PLAID_PRODUCTS}`);
  console.log(`\n   Endpoints:`);
console.log(`   POST /create_link_token`);
console.log(`   POST /exchange_public_token`);
console.log(`   GET  /accounts`);
console.log(`   GET  /categories`);
console.log(`   GET  /recurring`);
console.log(`   GET  /transactions`);
console.log(`   POST /webhook`);
console.log(`   GET  /health\n`);
});