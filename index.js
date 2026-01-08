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
const PUBLIC_URL = process.env.PUBLIC_URL;            // ex: https://tellegrampro.onrender.com
const CHAT_ID_VIP = String(process.env.CHAT_ID_VIP);  // ex: -1003676681893
const PORT = Number(process.env.PORT || 3000);

const PREVIAS_LINK = process.env.PREVIAS_LINK || "https://t.me/+QCsWxHpN0CtiZmU5";

if (!TOKEN || !MP_ACCESS_TOKEN || !PUBLIC_URL || !CHAT_ID_VIP) {
  throw new Error("❌ Falta TOKEN, MP_ACCESS_TOKEN, PUBLIC_URL ou CHAT_ID_VIP nas variáveis de ambiente");
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
  db.data.processed_payments ||= [];
  db.data.vip_access ||= [];
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
  const uid = String(userId);
  return db.data.vip_access.find(v => v.userId === uid)?.status || null;
}
function consume(userId) {
  const uid = String(userId);
  const row = db.data.vip_access.find(v => v.userId === uid);
  if (row) row.status = "consumed";
}

// ================== PLANS ==================
const PLANS = {
  mensal:    { id: "mensal",    title: "Plano Mensal",    price: 11.99 },
  vitalicio: { id: "vitalicio", title: "Plano Vitalício", price: 19.99 }
};

// ================== APP ==================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.send("OK ✅ (server on)"));
app.get("/mp/success", (_, res) => res.send("✅ Pagamento concluído. Volte ao Telegram e envie /vip."));
app.get("/mp/failure", (_, res) => res.send("❌ Pagamento falhou."));
app.get("/mp/pending", (_, res) => res.send("🟡 Pagamento pendente."));

// ================== BOT (WEBHOOK) ==================
const bot = new TelegramBot(TOKEN);

// ✅ Anti-duplicado de updates do Telegram
// (Telegram às vezes reenvia o mesmo update; isso evita repetir /start)
const seenUpdates = new Map(); // update_id -> timestamp
const SEEN_TTL_MS = 2 * 60 * 1000; // 2 minutos

function cleanupSeen() {
  const now = Date.now();
  for (const [id, ts] of seenUpdates.entries()) {
    if (now - ts > SEEN_TTL_MS) seenUpdates.delete(id);
  }
}

// Endpoint do webhook do Telegram (POST apenas)
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);

  try {
    const updateId = req.body?.update_id;
    if (typeof updateId === "number") {
      cleanupSeen();
      if (seenUpdates.has(updateId)) {
        // Ignora update duplicado
        return;
      }
      seenUpdates.set(updateId, Date.now());
    }

    await bot.processUpdate(req.body);
  } catch (e) {
    console.error("❌ processUpdate:", e?.response?.data || e.message || e);
  }
});

// ================== START VIDEO ==================
async function sendStartMedia(chatId) {
  const videoPath = path.join(__dirname, "assets", "start.mp4");

  if (!fs.existsSync(videoPath)) {
    console.log("⚠️ start.mp4 NÃO encontrado:", videoPath);
    return false;
  }

  try {
    await bot.sendVideo(chatId, fs.createReadStream(videoPath), {
      caption: "🔥 O queridinho do momento! 🔥"
    });
    console.log("✅ start.mp4 enviado para:", chatId);
    return true;
  } catch (e) {
    console.error("❌ Erro ao enviar start.mp4:", e?.response?.data || e.message || e);
    return false;
  }
}

// ================== KEYBOARD (BOTÕES) ==================
function salesKeyboard(mensalUrl, vitalicioUrl) {
  const rows = [
    [{ text: "🎬🔥 PRÉVIAS 🔥🎬", url: PREVIAS_LINK }],
  ];
  if (mensalUrl) rows.push([{ text: "💳 11,99 / MÊS 💎", url: mensalUrl }]);
  if (vitalicioUrl) rows.push([{ text: "💥 19,99 VITALÍCIO 🔥", url: vitalicioUrl }]);

  return { reply_markup: { inline_keyboard: rows } };
}

// ================== MERCADO PAGO ==================
async function criarPreferencia(plan, chatId) {
  const payload = {
    items: [{
      title: plan.title,
      quantity: 1,
      currency_id: "BRL",
      unit_price: plan.price
    }],
    external_reference: String(chatId),
    notification_url: `${PUBLIC_URL}/mp/webhook`,
    auto_return: "approved",
    back_urls: {
      success: `${PUBLIC_URL}/mp/success`,
      failure: `${PUBLIC_URL}/mp/failure`,
      pending: `${PUBLIC_URL}/mp/pending`
    },
    metadata: {
      plan_id: plan.id,
      expected_amount: plan.price,
      user_id: String(chatId)
    }
  };

  const r = await axios.post(
    "https://api.mercadopago.com/checkout/preferences",
    payload,
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
  console.log("📩 MP webhook recebido:", JSON.stringify(req.body));

  if (!paymentId) return;

  setImmediate(async () => {
    try {
      await db.read();

      const pid = String(paymentId);
      if (isProcessed(pid)) return;

      const payment = await getPayment(pid);
      markProcessed(pid);

      if (payment.status === "approved") {
        const userId = String(payment.external_reference || "");
        if (userId) setAuthorized(userId);
      }

      await db.write();
    } catch (e) {
      console.error("❌ ERRO no /mp/webhook:", e?.response?.data || e.message || e);
    }
  });
});

// ================== /start ==================
bot.onText(/^\/start$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // 1) gera links do MP
    const mensalUrl = await criarPreferencia(PLANS.mensal, chatId);
    const vitalicioUrl = await criarPreferencia(PLANS.vitalicio, chatId);

    // 2) envia vídeo 1x
    await sendStartMedia(chatId);

    // 3) envia a frase + botões (igual seu print)
    await bot.sendMessage(
      chatId,
      "👇 Escolha uma opção abaixo:",
      salesKeyboard(mensalUrl, vitalicioUrl)
    );

    console.log("📨 /start enviado para:", chatId);
  } catch (e) {
    console.error("❌ Erro no /start:", e?.response?.status, e?.response?.data || e.message || e);

    // Se MP falhar, manda só prévias + aviso (e NÃO repete vídeo)
    await bot.sendMessage(chatId, "👇 Escolha uma opção abaixo:", salesKeyboard(null, null));
    await bot.sendMessage(chatId, "⚠️ Erro ao gerar pagamento. Tente novamente em instantes.");
  }
});

// ================== /vip (LINK 1 USO) ==================
bot.onText(/^\/vip$/i, async (msg) => {
  const userChatId = msg.chat.id;

  try {
    await db.read();
    const status = getStatus(userChatId);

    if (status !== "authorized") {
      return bot.sendMessage(
        userChatId,
        "⚠️ Você ainda não está liberado.\n\n1) Envie /start\n2) Faça o pagamento\n3) Depois envie /vip"
      );
    }

    const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
      member_limit: 1,
      name: `VIP-${userChatId}-${Date.now()}`
    });

    consume(userChatId);
    await db.write();

    await bot.sendMessage(
      userChatId,
      `✅ *Acesso liberado!*\n\n🔓 Link VIP (1 uso):\n${invite.invite_link}`,
      { parse_mode: "Markdown" }
    );

    console.log("🚀 /vip -> link 1 uso enviado para:", userChatId);
  } catch (e) {
    console.error("❌ ERRO no /vip:", e?.response?.data || e.message || e);
    await bot.sendMessage(
      userChatId,
      "⚠️ Erro ao gerar link VIP. Confirme se o bot é ADMIN no VIP e tem permissão de convidar via link."
    );
  }
});

// ================== START SERVER + WEBHOOK ==================
(async () => {
  await initDB();

  app.listen(PORT, async () => {
    console.log(`🌐 Server rodando na porta ${PORT}`);

    const telegramWebhookUrl = `${PUBLIC_URL}/telegram`;
    await bot.setWebHook(telegramWebhookUrl);

    console.log("✅ Telegram webhook:", telegramWebhookUrl);
    console.log("✅ MP webhook:", `${PUBLIC_URL}/mp/webhook`);
  });
})();
