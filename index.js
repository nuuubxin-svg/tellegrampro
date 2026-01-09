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
  throw new Error("❌ Falta TOKEN, MP_ACCESS_TOKEN, PUBLIC_URL ou CHAT_ID_VIP no .env / Render");
}

// ================== DB ==================
const adapter = new JSONFile("db.json");
const db = new Low(adapter, null);

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
  mensal:    { id: "mensal",    title: "Plano Mensal",    price: 9.90 },
  vitalicio: { id: "vitalicio", title: "Plano Vitalício", price: 19.99 },
};

const closeMoney = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;

// ================== APP ==================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.send("OK ✅ (server on)"));
app.get("/telegram", (_, res) => res.send("OK ✅ (telegram endpoint expects POST)")); // só pra teste no browser

app.get("/mp/success", (_, res) => res.send("✅ Pagamento concluído. Volte ao Telegram e envie /vip."));
app.get("/mp/failure", (_, res) => res.send("❌ Pagamento falhou."));
app.get("/mp/pending", (_, res) => res.send("🟡 Pagamento pendente."));

// ================== BOT (webhook) ==================
const bot = new TelegramBot(TOKEN, { polling: false });

// Endpoint do webhook do Telegram
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  try {
    await bot.processUpdate(req.body);
  } catch (e) {
    console.error("❌ processUpdate:", e.message);
  }
});

// ================== START VIDEO ==================
async function sendStartMedia(chatId) {
  // Coloque o arquivo aqui no repo:
  // assets/start.mp4
  const videoPath = path.join(__dirname, "assets", "start.mp4");

  if (!fs.existsSync(videoPath)) {
    console.log("⚠️ start.mp4 NÃO encontrado:", videoPath);
    return;
  }

  try {
    await bot.sendVideo(chatId, fs.createReadStream(videoPath), {
      caption: "🔥 O queridinho do momento! 🔥"
    });
    console.log("✅ start.mp4 enviado para:", chatId);
  } catch (e) {
    console.error("❌ Erro ao enviar start.mp4:", e.message);
  }
}

// ================== Barrinha (Start + VIP lado a lado) ==================
function barStartVip() {
  return [
    [
      { text: "▶️ Start", callback_data: "DO_START" },
      { text: "🔓 VIP", callback_data: "DO_VIP" }
    ]
  ];
}

function salesKeyboard(mensalUrl, vitalicioUrl) {
  const rows = [
    [{ text: "🎬🔥 PRÉVIAS 🔥🎬", url: PREVIAS_LINK }],
  ];

  if (mensalUrl)    rows.push([{ text: "💳 9,90 / MÊS 💎", url: mensalUrl }]);
  if (vitalicioUrl) rows.push([{ text: "💥 19,99 VITALÍCIO 🔥", url: vitalicioUrl }]);

  // adiciona a barrinha com Start + VIP no final
  rows.push(...barStartVip());

  return { reply_markup: { inline_keyboard: rows } };
}

// ✅ teclado do VIP automático (botão "Entrar no VIP")
function vipAccessKeyboard(inviteLink) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔓 Entrar no VIP", url: inviteLink }],
        ...barStartVip()
      ]
    }
  };
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

// ✅ Extrai IDs numéricos (resource pode ser "1406..." ou URL)
function extractNumericId(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)(\?.*)?$/);
  return m ? m[1] : null;
}

// ✅ Merchant order (Mercado Livre) precisa ser consultada pra achar paymentId
async function getMerchantOrder(merchantOrderId) {
  const r = await axios.get(
    `https://api.mercadolibre.com/merchant_orders/${merchantOrderId}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return r.data;
}

// ================== VIP AUTOMÁTICO (novo) ==================
async function sendVipInviteNow(userChatId) {
  const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
    member_limit: 1,
    name: `VIP-${userChatId}-${Date.now()}`
  });

  // ✅ envia mensagem com botão "Entrar no VIP" (mais fácil pro usuário)
  await bot.sendMessage(
    userChatId,
    `✅ *Pagamento aprovado!*\n\n🔓 Seu acesso VIP está liberado.\nClique no botão abaixo para entrar:`,
    {
      parse_mode: "Markdown",
      ...vipAccessKeyboard(invite.invite_link)
    }
  );

  console.log("🚀 AUTO VIP -> link 1 uso enviado para:", userChatId);
  return invite.invite_link;
}

// ================== MP WEBHOOK (libera e ENVIA AUTOMÁTICO) ==================
app.post("/mp/webhook", (req, res) => {
  res.sendStatus(200);

  console.log("📩 MP webhook recebido:", JSON.stringify(req.body));

  setImmediate(async () => {
    try {
      await db.read();
      db.data ||= { processed_payments: [], vip_access: [] };
      db.data.processed_payments ||= [];
      db.data.vip_access ||= [];

      const body = req.body || {};
      const topic = body?.topic || body?.type;

      // ✅ pega paymentId de data.id, id, OU resource numérico
      let paymentId =
        body?.data?.id ||
        body?.id ||
        extractNumericId(body?.resource);

      // ✅ se for merchant_order, consulta a ordem pra achar paymentId
      if ((!paymentId) && topic === "merchant_order") {
        const moId = extractNumericId(body?.resource);
        if (!moId) {
          console.log("⚠️ MP merchant_order sem id extraível (ignorado)");
          return;
        }

        const mo = await getMerchantOrder(moId);
        const payments = mo?.payments || [];
        const lastPayment = payments[payments.length - 1];

        if (lastPayment?.id) {
          paymentId = String(lastPayment.id);
        } else {
          console.log("⚠️ Merchant order sem payments ainda:", moId);
          return;
        }
      }

      if (!paymentId) {
        console.log("⚠️ MP webhook sem paymentId (ignorado)");
        return;
      }

      const pid = String(paymentId);

      // ✅ só ignora se já foi finalizado (approved) antes
      if (isProcessed(pid)) {
        console.log("🔁 Pagamento já processado:", pid);
        return;
      }

      const payment = await getPayment(pid);

      const status = payment.status;
      const userId = String(payment.external_reference || "");
      const amount = Number(payment.transaction_amount || 0);
      const planId = payment.metadata?.plan_id;
      const expected = payment.metadata?.expected_amount;

      console.log("✅ Payment details:", { pid, status, userId, amount, planId, expected });

      const plan = planId
        ? PLANS[planId]
        : Object.values(PLANS).find(p => closeMoney(p.price, amount));

      // ✅ SÓ finaliza quando approved e valores batem
      if (status === "approved" && userId && plan && closeMoney(expected ?? plan.price, amount)) {
        // libera no DB
        setAuthorized(userId);

        // ✅ envia automaticamente o VIP
        try {
          await sendVipInviteNow(userId);
          consume(userId); // marca como consumido porque já mandou o link
        } catch (e) {
          console.error("❌ Falha ao enviar VIP automático:", e?.response?.data || e.message);
          // fica authorized para a pessoa usar /vip como fallback
        }

        // marca pagamento como finalizado
        markProcessed(pid);

        console.log("🎉 VIP LIBERADO + enviado automático para userId:", userId);
      } else {
        console.log("🟡 Não liberou (ainda não aprovado ou não bateu):", { status, userId, amount, planId, expected });
        // ❌ NÃO marca processado aqui (pra não bloquear quando virar approved)
      }

      await db.write();
    } catch (e) {
      console.error("❌ ERRO no /mp/webhook:", e?.response?.data || e.message);
    }
  });
});

// ================== BLOQUEIO de mídia (reforçado por tipo) ==================
async function blockMedia(msg) {
  const chatId = msg.chat.id;

  // se vier /start ou /vip como texto, não bloquear
  const text = msg.text || "";
  if (/^\/start/i.test(text) || /^\/vip/i.test(text)) return;

  // tenta apagar a mensagem proibida
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) {
    // em grupo/canal pode falhar se o bot não for admin
  }

  await bot.sendMessage(
    chatId,
    "🚫 Não aceito áudio/foto/vídeo/arquivos aqui.\n✅ Envie apenas *texto* ou use os botões:",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: barStartVip() }
    }
  );
}

bot.on("photo", blockMedia);
bot.on("voice", blockMedia);
bot.on("audio", blockMedia);
bot.on("video", blockMedia);
bot.on("video_note", blockMedia);
bot.on("document", blockMedia);
bot.on("animation", blockMedia);
bot.on("sticker", blockMedia);
bot.on("location", blockMedia);
bot.on("contact", blockMedia);

// ================== Fluxo reaproveitável do START ==================
async function runStartFlow(chatId) {
  await sendStartMedia(chatId);

  const mensalUrl = await criarPreferencia(PLANS.mensal, chatId);
  const vitalicioUrl = await criarPreferencia(PLANS.vitalicio, chatId);

  await bot.sendMessage(chatId, "👇 Escolha uma opção abaixo:", salesKeyboard(mensalUrl, vitalicioUrl));

  console.log("📨 START flow enviado para:", chatId);
}

// ================== Fluxo reaproveitável do VIP ==================
async function runVipFlow(userChatId) {
  await db.read();
  db.data ||= { processed_payments: [], vip_access: [] };

  const status = getStatus(userChatId);

  if (status !== "authorized") {
    return bot.sendMessage(
      userChatId,
      "⚠️ Você ainda não está liberado.\n\n" +
      "✅ Passo a passo:\n" +
      "1) Envie /start\n" +
      "2) Faça o pagamento\n" +
      "3) Aguarde a aprovação (o link pode chegar automático)\n\n" +
      "Se você já pagou e ainda não liberou, aguarde 1-2 min e tente /vip novamente.",
      { reply_markup: { inline_keyboard: barStartVip() } }
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
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: barStartVip() }
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
    await bot.sendMessage(chatId, "⚠️ Erro ao gerar pagamento. Tente novamente em instantes.", {
      reply_markup: { inline_keyboard: barStartVip() }
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
      "⚠️ Erro ao gerar link VIP.\nConfirme se o bot é ADMIN no VIP e tem permissão de convidar via link.",
      { reply_markup: { inline_keyboard: barStartVip() } }
    );
  }
});

// ================== Botões Start/VIP (callback) ==================
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data;

  if (!chatId) return;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (_) {}

  if (data === "DO_START") {
    try {
      await runStartFlow(chatId);
    } catch (e) {
      console.error("❌ Erro DO_START:", e?.response?.data || e.message);
      await bot.sendMessage(chatId, "⚠️ Erro ao iniciar. Tente novamente.", {
        reply_markup: { inline_keyboard: barStartVip() }
      });
    }
  }

  if (data === "DO_VIP") {
    try {
      await runVipFlow(chatId);
    } catch (e) {
      console.error("❌ Erro DO_VIP:", e?.response?.data || e.message);
      await bot.sendMessage(chatId, "⚠️ Erro ao gerar VIP. Tente novamente.", {
        reply_markup: { inline_keyboard: barStartVip() }
      });
    }
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
