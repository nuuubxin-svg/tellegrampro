require("dotenv").config();

const express = require("express");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");
const fs = require("fs");
const path = require("path");

// ================== ENV ==================
const TOKEN = process.env.TOKEN;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const CHAT_ID_VIP = String(process.env.CHAT_ID_VIP);
const PORT = Number(process.env.PORT || 3000);

const PREVIAS_LINK = process.env.PREVIAS_LINK || "https://t.me/+QCsWxHpN0CtiZmU5";

if (!TOKEN || !MP_ACCESS_TOKEN || !PUBLIC_URL || !CHAT_ID_VIP) {
  throw new Error("❌ Falta variável de ambiente");
}

// ================== DB ==================
const adapter = new JSONFile("db.json");
const db = new Low(adapter, null);

async function initDB() {
  await db.read();
  db.data ||= { processed_payments: [], vip_access: [] };
  await db.write();
}

const isProcessed = (id) => db.data.processed_payments.includes(String(id));
const markProcessed = (id) => db.data.processed_payments.push(String(id));

const setAuthorized = (userId) => {
  db.data.vip_access = db.data.vip_access.filter(v => v.userId !== String(userId));
  db.data.vip_access.push({ userId: String(userId), status: "authorized" });
};

const consume = (userId) => {
  const row = db.data.vip_access.find(v => v.userId === String(userId));
  if (row) row.status = "consumed";
};

const getStatus = (userId) =>
  db.data.vip_access.find(v => v.userId === String(userId))?.status || null;

// ================== BOT ==================
const app = express();
app.use(express.json({ limit: "1mb" }));

const bot = new TelegramBot(TOKEN, { polling: false });

// ================== HELPERS ==================
function extractNumericId(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)/);
  return m ? m[1] : null;
}

async function getPayment(pid) {
  const r = await axios.get(
    `https://api.mercadopago.com/v1/payments/${pid}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return r.data;
}

async function getMerchantOrder(id) {
  const r = await axios.get(
    `https://api.mercadolibre.com/merchant_orders/${id}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return r.data;
}

// ================== AUTO VIP ==================
async function sendVipInviteNow(userChatId) {
  const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
    member_limit: 1,
    name: `VIP-${userChatId}-${Date.now()}`
  });

  await bot.sendMessage(
    userChatId,
    `✅ *Pagamento aprovado!*\n\n🔓 *Seu acesso VIP:*\n${invite.invite_link}`,
    { parse_mode: "Markdown" }
  );

  console.log("🚀 VIP enviado automaticamente para:", userChatId);
}

// ================== WEBHOOK MP ==================
app.post("/mp/webhook", (req, res) => {
  res.sendStatus(200);
  console.log("📩 MP webhook recebido:", JSON.stringify(req.body));

  setImmediate(async () => {
    await db.read();

    let paymentId =
      req.body?.data?.id ||
      extractNumericId(req.body?.resource);

    if (!paymentId && req.body?.topic === "merchant_order") {
      const moId = extractNumericId(req.body.resource);
      const mo = await getMerchantOrder(moId);
      paymentId = mo?.payments?.slice(-1)[0]?.id;
    }

    if (!paymentId || isProcessed(paymentId)) return;

    const p = await getPayment(paymentId);
    const status = p.status;
    const userId = p.external_reference;

    if (status === "approved" && userId) {
      setAuthorized(userId);

      try {
        await sendVipInviteNow(userId);
        consume(userId);
      } catch (e) {
        console.error("❌ Erro envio automático:", e.message);
      }

      markProcessed(paymentId);
      await db.write();
    }
  });
});

// ================== TELEGRAM ==================
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  await bot.processUpdate(req.body);
});

bot.onText(/\/start/i, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "🔥 Bem-vindo! Faça o pagamento e o acesso VIP será enviado automaticamente."
  );
});

bot.onText(/\/vip/i, async (msg) => {
  await db.read();
  if (getStatus(msg.chat.id) === "authorized") {
    await sendVipInviteNow(msg.chat.id);
    consume(msg.chat.id);
    await db.write();
  } else {
    await bot.sendMessage(msg.chat.id, "⚠️ Você ainda não está liberado.");
  }
});

// ================== START ==================
(async () => {
  await initDB();
  app.listen(PORT, async () => {
    await bot.setWebHook(`${PUBLIC_URL}/telegram`);
    console.log("🚀 BOT ONLINE");
  });
})();
