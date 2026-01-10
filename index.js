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
let PUBLIC_URL = process.env.PUBLIC_URL; // ex: https://tellegrampro.onrender.com
const CHAT_ID_VIP = String(process.env.CHAT_ID_VIP || "");
const PORT = Number(process.env.PORT || 3000);
const PREVIAS_LINK = process.env.PREVIAS_LINK || "https://t.me/seu_canal_previas";

if (!TOKEN || !MP_ACCESS_TOKEN || !PUBLIC_URL || !CHAT_ID_VIP) {
  console.error("❌ Falta TOKEN, MP_ACCESS_TOKEN, PUBLIC_URL ou CHAT_ID_VIP no Render.");
  process.exit(1);
}

// remove barra final se existir
PUBLIC_URL = PUBLIC_URL.replace(/\/+$/, "");

// ================== DB ==================
const adapter = new JSONFile("db.json");
const db = new Low(adapter, null);

// lock em memória para evitar corrida de webhooks simultâneos
const processingPayments = new Set();

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

// NÃO resetar vip_sent ao autorizar novamente (idempotência real)
function setAuthorized(userId) {
  const uid = String(userId);
  const existing = db.data.vip_access.find((v) => v.userId === uid);
  const vipSent = existing?.vip_sent === true;

  db.data.vip_access = db.data.vip_access.filter((v) => v.userId !== uid);
  db.data.vip_access.push({
    userId: uid,
    status: "authorized",
    ts: Date.now(),
    vip_sent: vipSent,
  });
}

function getStatus(userId) {
  const uid = String(userId);
  return db.data.vip_access.find((v) => v.userId === uid)?.status || null;
}

function consume(userId) {
  const uid = String(userId);
  const row = db.data.vip_access.find((v) => v.userId === uid);
  if (row) row.status = "consumed";
}

// trava anti-duplicidade do VIP automático
function hasVipSent(userId) {
  const uid = String(userId);
  const row = db.data.vip_access.find((v) => v.userId === uid);
  return row?.vip_sent === true;
}

function markVipSent(userId) {
  const uid = String(userId);
  const row = db.data.vip_access.find((v) => v.userId === uid);
  if (row) row.vip_sent = true;
}

function unmarkVipSent(userId) {
  const uid = String(userId);
  const row = db.data.vip_access.find((v) => v.userId === uid);
  if (row) row.vip_sent = false;
}

// ================== PLANS ==================
const PLANS = {
  mensal: { id: "mensal", title: "Plano Mensal", price: 9.9 },
  vitalicio: { id: "vitalicio", title: "Plano Vitalício", price: 19.99 },
};

const closeMoney = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;

// ================== APP ==================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.send("OK ✅ (server on)"));
app.get("/telegram", (_, res) => res.send("OK ✅ (telegram endpoint expects POST)"));
app.get("/mp/success", (_, res) => res.send("✅ Pagamento concluído. Volte ao Telegram e aguarde o link VIP."));
app.get("/mp/failure", (_, res) => res.send("❌ Pagamento falhou."));
app.get("/mp/pending", (_, res) => res.send("🟡 Pagamento pendente."));

// ================== BOT (webhook) ==================
const bot = new TelegramBot(TOKEN, { polling: false });

// ✅ Endpoint do webhook do Telegram (POST)
app.post("/telegram", async (req, res) => {
  // responde imediatamente para o Telegram
  res.sendStatus(200);

  // LOG para confirmar que o Telegram está chegando
  console.log("📩 UPDATE DO TELEGRAM:", JSON.stringify(req.body));

  try {
    await bot.processUpdate(req.body);
  } catch (e) {
    console.error("❌ processUpdate:", e?.message || e);
  }
});

// ================== TECLADOS ==================
function barGiftOnlyBig() {
  return [[{ text: "🎁 ver opções 🎁", callback_data: "DO_GIFT" }]];
}

function barVipBlocked() {
  return [[
    { text: "▶️ Start", callback_data: "DO_START" },
    { text: "🔓 VIP", callback_data: "DO_VIP" }
  ]];
}

function salesKeyboard(mensalUrl, vitalicioUrl) {
  const rows = [
    [{ text: "📌 Informações / Prévia", url: PREVIAS_LINK }],
  ];
  if (mensalUrl) rows.push([{ text: "💳 9,90 / MÊS", url: mensalUrl }]);
  if (vitalicioUrl) rows.push([{ text: "💥 19,99 VITALÍCIO", url: vitalicioUrl }]);
  rows.push(...barGiftOnlyBig());
  return { reply_markup: { inline_keyboard: rows } };
}

function paymentOnlyKeyboard(mensalUrl, vitalicioUrl) {
  const rows = [];
  if (mensalUrl) rows.push([{ text: "💳 9,90 / MÊS", url: mensalUrl }]);
  if (vitalicioUrl) rows.push([{ text: "💥 19,99 VITALÍCIO", url: vitalicioUrl }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function vipAccessKeyboard(inviteLink) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🔓 Entrar no VIP", url: inviteLink }]],
    },
  };
}

// ================== START MEDIA ==================
async function sendStartMedia(chatId, mensalUrl, vitalicioUrl) {
  const videoPath = path.join(__dirname, "assets", "start.mp4");

  const caption = `✅ <b>Bem-vindo!</b>

Assine um plano e receba acesso ao grupo VIP automaticamente após a aprovação do pagamento.

<b>Escolha um plano abaixo:</b>`;

  // Se tiver vídeo, envia. Se não tiver, manda texto.
  if (fs.existsSync(videoPath)) {
    try {
      await bot.sendVideo(chatId, fs.createReadStream(videoPath), {
        caption,
        parse_mode: "HTML",
        ...salesKeyboard(mensalUrl, vitalicioUrl),
      });
      console.log("✅ start.mp4 enviado para:", chatId);
      return;
    } catch (e) {
      console.error("❌ Erro ao enviar start.mp4:", e?.message || e);
    }
  }

  await bot.sendMessage(chatId, caption, {
    parse_mode: "HTML",
    ...salesKeyboard(mensalUrl, vitalicioUrl),
  });
}

// ================== MERCADO PAGO ==================
async function criarPreferencia(plan, chatId) {
  const payload = {
    items: [
      {
        title: plan.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: plan.price,
      },
    ],
    external_reference: String(chatId),
    notification_url: `${PUBLIC_URL}/mp/webhook`,
    auto_return: "approved",
    back_urls: {
      success: `${PUBLIC_URL}/mp/success`,
      failure: `${PUBLIC_URL}/mp/failure`,
      pending: `${PUBLIC_URL}/mp/pending`,
    },
    metadata: {
      plan_id: plan.id,
      expected_amount: plan.price,
      user_id: String(chatId),
    },
  };

  const r = await axios.post(
    "https://api.mercadopago.com/checkout/preferences",
    payload,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );

  return r.data.init_point;
}

async function getPayment(paymentId) {
  const r = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  return r.data;
}

function extractNumericId(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)(\?.*)?$/);
  return m ? m[1] : null;
}

async function getMerchantOrder(merchantOrderId) {
  const r = await axios.get(`https://api.mercadolibre.com/merchant_orders/${merchantOrderId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  return r.data;
}

// ================== VIP AUTOMÁTICO ==================
async function sendVipInviteNow(userChatId) {
  const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
    member_limit: 1,
    name: `VIP-${userChatId}-${Date.now()}`,
  });

  await bot.sendMessage(
    userChatId,
    `✅ *Pagamento aprovado!*\n\n🔓 Seu acesso VIP está liberado.\nClique no botão abaixo para entrar:`,
    {
      parse_mode: "Markdown",
      ...vipAccessKeyboard(invite.invite_link),
    }
  );

  console.log("🚀 AUTO VIP -> link 1 uso enviado para:", userChatId);
  return invite.invite_link;
}

// ================== MP WEBHOOK ==================
app.post("/mp/webhook", (req, res) => {
  res.sendStatus(200);
  console.log("📩 MP webhook recebido:", JSON.stringify(req.body));

  setImmediate(async () => {
    let lockedPid = null;

    try {
      await db.read();
      db.data ||= { processed_payments: [], vip_access: [] };
      db.data.processed_payments ||= [];
      db.data.vip_access ||= [];

      const body = req.body || {};
      const topic = body?.topic || body?.type;

      let paymentId = body?.data?.id || body?.id || extractNumericId(body?.resource);

      if (!paymentId && topic === "merchant_order") {
        const moId = extractNumericId(body?.resource);
        if (!moId) return console.log("⚠️ MP merchant_order sem id (ignorado)");

        const mo = await getMerchantOrder(moId);
        const payments = mo?.payments || [];
        const lastPayment = payments[payments.length - 1];

        if (lastPayment?.id) paymentId = String(lastPayment.id);
        else return console.log("⚠️ Merchant order sem payments ainda:", moId);
      }

      if (!paymentId) return console.log("⚠️ MP webhook sem paymentId (ignorado)");

      const pid = String(paymentId);

      if (processingPayments.has(pid)) {
        return console.log("⏳ Pagamento em processamento (lock):", pid);
      }
      processingPayments.add(pid);
      lockedPid = pid;

      if (isProcessed(pid)) return console.log("🔁 Pagamento já processado:", pid);

      const payment = await getPayment(pid);
      const status = payment.status;
      const userId = String(payment.external_reference || "");
      const amount = Number(payment.transaction_amount || 0);
      const planId = payment.metadata?.plan_id;
      const expected = payment.metadata?.expected_amount;

      console.log("✅ Payment details:", { pid, status, userId, amount, planId, expected });

      const plan = planId
        ? PLANS[planId]
        : Object.values(PLANS).find((p) => closeMoney(p.price, amount));

      if (status === "approved" && userId && plan && closeMoney(expected ?? plan.price, amount)) {
        setAuthorized(userId);

        if (hasVipSent(userId)) {
          console.log("🔁 VIP já enviado para userId:", userId);
          markProcessed(pid);
          await db.write();
          return;
        }

        markVipSent(userId);
        markProcessed(pid);
        await db.write();

        try {
          await sendVipInviteNow(userId);
          consume(userId);
          await db.write();
        } catch (e) {
          console.error("❌ Falha ao enviar VIP automático:", e?.response?.data || e.message);
          unmarkVipSent(userId);
          await db.write();
        }

        console.log("🎉 VIP liberado e enviado automaticamente para userId:", userId);
      } else {
        console.log("🟡 Não liberou (ainda não aprovado ou não bateu):", {
          status,
          userId,
          amount,
          planId,
          expected,
        });
      }
    } catch (e) {
      console.error("❌ ERRO no /mp/webhook:", e?.response?.data || e.message);
    } finally {
      if (lockedPid) processingPayments.delete(lockedPid);
    }
  });
});

// ================== FLOWS ==================
async function runStartFlow(chatId) {
  const mensalUrl = await criarPreferencia(PLANS.mensal, chatId);
  const vitalicioUrl = await criarPreferencia(PLANS.vitalicio, chatId);
  await sendStartMedia(chatId, mensalUrl, vitalicioUrl);
  console.log("📨 START flow enviado para:", chatId);
}

async function runGiftFlow(chatId) {
  const mensalUrl = await criarPreferencia(PLANS.mensal, chatId);
  const vitalicioUrl = await criarPreferencia(PLANS.vitalicio, chatId);

  const videoPath = path.join(__dirname, "assets", "pagamento.mp4");
  const caption = `✅ <b>Conteúdo disponível</b>\n\nEscolha um plano para continuar:`;

  if (fs.existsSync(videoPath)) {
    try {
      await bot.sendVideo(chatId, fs.createReadStream(videoPath), {
        caption,
        parse_mode: "HTML",
        ...paymentOnlyKeyboard(mensalUrl, vitalicioUrl),
      });
      console.log("✅ pagamento.mp4 enviado para:", chatId);
      return;
    } catch (e) {
      console.error("❌ Erro ao enviar pagamento.mp4:", e?.message || e);
    }
  }

  await bot.sendMessage(chatId, caption, {
    parse_mode: "HTML",
    ...paymentOnlyKeyboard(mensalUrl, vitalicioUrl),
  });
}

async function runVipFlow(userChatId) {
  await db.read();
  db.data ||= { processed_payments: [], vip_access: [] };

  const status = getStatus(userChatId);

  if (status !== "authorized") {
    return bot.sendMessage(
      userChatId,
      "⚠️ Você ainda não está liberado.\n\n" +
        "✅ Passo a passo:\n" +
        "1) Clique em /start\n" +
        "2) Faça o pagamento\n" +
        "3) Aguarde a aprovação (o link chega automaticamente)\n\n" +
        "Se você já pagou, aguarde 1–2 minutos e tente /vip novamente.",
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: barVipBlocked() },
      }
    );
  }

  const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
    member_limit: 1,
    name: `VIP-${userChatId}-${Date.now()}`,
  });

  consume(userChatId);
  await db.write();

  await bot.sendMessage(
    userChatId,
    `✅ *Acesso liberado!*\n\n🔓 Link VIP (1 uso):\n${invite.invite_link}`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: barGiftOnlyBig() },
    }
  );

  console.log("🚀 VIP flow -> link 1 uso enviado para:", userChatId);
}

// ================== /start ==================
bot.onText(/\/start/i, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await runStartFlow(chatId);
  } catch (e) {
    console.error("❌ Erro no /start:", e?.response?.data || e.message);
    await bot.sendMessage(chatId, "⚠️ Erro ao iniciar. Tente novamente.", {
      reply_markup: { inline_keyboard: barGiftOnlyBig() },
    });
  }
});

// ================== /vip ==================
bot.onText(/\/vip/i, async (msg) => {
  const userChatId = msg.chat.id;
  try {
    await runVipFlow(userChatId);
  } catch (e) {
    console.error("❌ ERRO no /vip:", e?.response?.data || e.message);
    await bot.sendMessage(
      userChatId,
      "⚠️ Erro ao gerar link VIP.\nConfirme se o bot é ADMIN no grupo VIP e tem permissão para criar convites.",
      { reply_markup: { inline_keyboard: barGiftOnlyBig() } }
    );
  }
});

// ================== CALLBACKS ==================
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data;
  if (!chatId) return;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (_) {}

  if (data === "DO_START") {
    try { await runStartFlow(chatId); } catch (e) { console.error(e); }
  }

  if (data === "DO_GIFT") {
    try { await runGiftFlow(chatId); } catch (e) { console.error(e); }
  }

  if (data === "DO_VIP") {
    try { await runVipFlow(chatId); } catch (e) { console.error(e); }
  }
});

// ================== START SERVER + WEBHOOK ==================
(async () => {
  await initDB();

  app.listen(PORT, async () => {
    console.log(`🌐 Server rodando na porta ${PORT}`);

    const telegramWebhookUrl = `${PUBLIC_URL}/telegram`;

    try {
      await bot.setWebHook(telegramWebhookUrl, { drop_pending_updates: true });
      console.log("✅ Telegram webhook:", telegramWebhookUrl);
    } catch (e) {
      console.error("❌ Falha ao setar webhook:", e?.message || e);
    }

    console.log("✅ MP webhook:", `${PUBLIC_URL}/mp/webhook`);
  });
})();
