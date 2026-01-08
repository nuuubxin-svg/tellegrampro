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
const db = new Low(adapter, {
  processed_payments: [],
  vip_access: []
});

async function initDB() {
  await db.read();
  db.data ||= { processed_payments: [], vip_access: [] };
  await db.write();
}

function isProcessed(paymentId) {
  return db.data.processed_payments.includes(String(paymentId));
}
function markProcessed(paymentId) {
  db.data.processed_payments.push(String(paymentId));
}
function setAuthorized(userId) {
  const uid = String(userId);
  db.data.vip_access = db.data.vip_access.filter(v => v.userId !== uid);
  db.data.vip_access.push({ userId: uid, status: "authorized", ts: Date.now() });
}
function getStatus(userId) {
  return db.data.vip_access.find(v => v.userId === String(userId))?.status || null;
}
function consume(userId) {
  const row = db.data.vip_access.find(v => v.userId === String(userId));
  if (row) row.status = "consumed";
}

// ================== PLANS ==================
const PLANS = {
  mensal: { id: "mensal", title: "Plano Mensal", price: 11.99 },
  vitalicio: { id: "vitalicio", title: "Plano Vitalício", price: 19.99 }
};

// ================== APP ==================
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("OK"));

app.get("/mp/success", (_, res) => res.send("Pagamento aprovado. Volte ao Telegram."));
app.get("/mp/failure", (_, res) => res.send("Pagamento falhou."));
app.get("/mp/pending", (_, res) => res.send("Pagamento pendente."));

// ================== BOT ==================
const bot = new TelegramBot(TOKEN);

// webhook telegram
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  await bot.processUpdate(req.body);
});

// ================== START VIDEO ==================
async function sendStartMedia(chatId) {
  const videoPath = path.join(__dirname, "assets", "start.mp4");

  if (!fs.existsSync(videoPath)) {
    console.log("⚠️ start.mp4 não encontrado");
    return;
  }

  await bot.sendVideo(chatId, fs.createReadStream(videoPath), {
    caption: "🔥 O queridinho do momento! 🔥"
  });
}

// ================== KEYBOARD ==================
function salesKeyboard(mensalUrl, vitalicioUrl) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎬 PRÉVIAS", url: PREVIAS_LINK }],
        [{ text: "💳 11,99 / MÊS", url: mensalUrl }],
        [{ text: "💥 19,99 VITALÍCIO", url: vitalicioUrl }]
      ]
    }
  };
}

// ================== MERCADO PAGO ==================
async function criarPreferencia(plan, chatId) {
  const r = await axios.post(
    "https://api.mercadopago.com/checkout/preferences",
    {
      items: [{
        title: plan.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: plan.price
      }],
      external_reference: String(chatId),
      notification_url: `${PUBLIC_URL}/mp/webhook`,
      metadata: {
        plan_id: plan.id,
        expected_amount: plan.price
      }
    },
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return r.data.init_point;
}

async function getPayment(paymentId) {
  const r = await axios.get(
    `https://api.mercadopago.com/v1/payments/${paymentId}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return r.data;
}

// ================== MP WEBHOOK ==================
app.post("/mp/webhook", (req, res) => {
  res.sendStatus(200);

  const paymentId = req.body?.data?.id || req.body?.id;
  if (!paymentId) return;

  setImmediate(async () => {
    await db.read();
    if (isProcessed(paymentId)) return;

    const payment = await getPayment(paymentId);
    markProcessed(paymentId);

    if (payment.status === "approved") {
      setAuthorized(payment.external_reference);
      console.log("VIP autorizado:", payment.external_reference);
    }

    await db.write();
  });
});

// ================== /start ==================
bot.onText(/^\/start$/i, async (msg) => {
  const chatId = msg.chat.id;

  const mensal = await criarPreferencia(PLANS.mensal, chatId);
  const vitalicio = await criarPreferencia(PLANS.vitalicio, chatId);

  await sendStartMedia(chatId);
  await bot.sendMessage(chatId, " ", salesKeyboard(mensal, vitalicio));
});

// ================== /vip ==================
bot.onText(/^\/vip$/i, async (msg) => {
  const userId = msg.chat.id;

  await db.read();
  if (getStatus(userId) !== "authorized") {
    return bot.sendMessage(userId, "Pagamento ainda não confirmado.");
  }

  const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
    member_limit: 1
  });

  consume(userId);
  await db.write();

  await bot.sendMessage(userId, `🔓 Link VIP (1 uso):\n${invite.invite_link}`);
});

// ================== START SERVER ==================
(async () => {
  await initDB();

  app.listen(PORT, async () => {
    await bot.setWebHook(`${PUBLIC_URL}/telegram`);
    console.log("BOT ONLINE");
  });
})();
