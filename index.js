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

const PREVIAS_LINK = process.env.PREVIAS_LINK;

if (!TOKEN || !MP_ACCESS_TOKEN || !PUBLIC_URL || !CHAT_ID_VIP) {
  throw new Error("❌ Variáveis de ambiente faltando");
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

// ================== APP ==================
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("OK"));

app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  await bot.processUpdate(req.body);
});

// ================== BOT ==================
const bot = new TelegramBot(TOKEN);

// ================== START VIDEO ==================
async function sendStartMedia(chatId) {
  const videoPath = path.join(__dirname, "assets", "start.mp4");
  if (!fs.existsSync(videoPath)) return;

  await bot.sendVideo(chatId, fs.createReadStream(videoPath), {
    caption: "🔥 O queridinho do momento! 🔥"
  });
}

function keyboard(mensal, vitalicio) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎬 PRÉVIAS", url: PREVIAS_LINK }],
        [{ text: "💳 11,99 / MÊS", url: mensal }],
        [{ text: "💥 19,99 VITALÍCIO", url: vitalicio }]
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
      notification_url: `${PUBLIC_URL}/mp/webhook`
    },
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return r.data.init_point;
}

// ================== /start ==================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await sendStartMedia(chatId);

  const mensal = await criarPreferencia({ title: "Plano Mensal", price: 11.99 }, chatId);
  const vitalicio = await criarPreferencia({ title: "Plano Vitalício", price: 19.99 }, chatId);

  await bot.sendMessage(chatId, " ", keyboard(mensal, vitalicio));
});

// ================== /vip ==================
bot.onText(/\/vip/, async (msg) => {
  const invite = await bot.createChatInviteLink(CHAT_ID_VIP, {
    member_limit: 1
  });

  await bot.sendMessage(
    msg.chat.id,
    `🔓 *Link VIP (1 uso):*\n${invite.invite_link}`,
    { parse_mode: "Markdown" }
  );
});

// ================== START ==================
(async () => {
  await initDB();

  app.listen(PORT, async () => {
    await bot.deleteWebHook();
    await bot.setWebHook(`${PUBLIC_URL}/telegram`);
    console.log("BOT ONLINE");
  });
})();
