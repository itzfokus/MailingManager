import "dotenv/config";
import { Bot, InlineKeyboard, Api, InputFile } from "grammy";
import { botsDb, BotRecord } from "./db";
import { log } from "./logger";
import fs from "fs";
import path from "path";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is not set in .env");

const OWNER_IDS = (process.env.OWNER_ID ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);
if (OWNER_IDS.length === 0) throw new Error("OWNER_ID is not set in .env");
const bot = new Bot(token);

bot.use((ctx, next) => {
  if (!OWNER_IDS.includes(ctx.from?.id ?? 0)) {
    log.warn(`Ignored update from unauthorized user ${ctx.from?.id ?? "unknown"}`);
    return;
  }
  return next();
});


interface ParsedButton {
  type: "url" | "copy";
  label: string;
  value: string;
}

interface StoredMessage {
  type: "text" | "photo";
  text?: string;
  entities?: any[];
  photoFileId?: string;
  caption?: string;
  captionEntities?: any[];
}

interface MailingState {
  step: "file" | "message" | "confirm" | "inline";
  botId: number;
  userIds: number[];
  msg?: StoredMessage;
  inlineButtons: ParsedButton[];
}

interface MailingProgress {
  total: number;
  sent: number;
  errors: number;
  stopped: boolean;
}

let waitingForToken = false;
let mailingState: MailingState | null = null;
let currentMailing: MailingProgress | null = null;

function parseButtons(text: string): ParsedButton[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): ParsedButton[] => {
      const parts = line.split(" - ").map((p) => p.trim());
      if (parts.length < 3) return [];
      const type = parts[0].toUpperCase();
      const value = parts[1];
      const label = parts.slice(2).join(" - ");
      if (type === "URL") return [{ type: "url", label, value }];
      if (type === "COPY") return [{ type: "copy", label, value }];
      return [];
    });
}

function buildInlineKeyboard(buttons: ParsedButton[]): InlineKeyboard | undefined {
  if (buttons.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (const btn of buttons) {
    if (btn.type === "url") {
      const url = btn.value.startsWith("http") ? btn.value : `https://${btn.value}`;
      kb.url(btn.label, url).row();
    } else {
      kb.add({ text: btn.label, copy_text: { text: btn.value } } as any).row();
    }
  }
  return kb;
}

function getProgressText(p: MailingProgress, done = false): string {
  const title = done
    ? p.stopped
      ? '<b><tg-emoji emoji-id="5323535839391653590">🔴</tg-emoji> Рассылка остановлена!</b>'
      : '<b><tg-emoji emoji-id="5323307196807653127">🟢</tg-emoji> Рассылка завершена!</b>'
    : '<b><tg-emoji emoji-id="5323505443908100128">🟠</tg-emoji> Рассылка запущена!</b>';

  return `${title}\n\n<b>Отправил:</b> ${p.sent}/${p.total}\n<b>Ошибок:</b> ${p.errors}`;
}

function progressKeyboard(p: MailingProgress) {
  return new InlineKeyboard()
    .add({ text: "Stop", callback_data: "mailing_stop", icon_custom_emoji_id: "5260342697075416641" }).row()
    .text(`${p.sent + p.errors} / ${p.total}`, "noop");
}

async function runMailing(state: MailingState, chatId: number, msgId: number) {
  if (!state.msg || !currentMailing) return;
  const botRecord = botsDb.getById(state.botId);
  if (!botRecord) return;

  const targetApi = new Api(botRecord.token);

  log.mail(`Рассылка запущена | бот: @${botRecord.username} | получателей: ${state.userIds.length} | кнопок: ${state.inlineButtons.length}`);

  let photoBuffer: Buffer | undefined;
  let cachedPhotoFileId: string | undefined;
  if (state.msg.type === "photo" && state.msg.photoFileId) {
    log.info("Скачиваю фото для рассылки...");
    const file = await bot.api.getFile(state.msg.photoFileId);
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    photoBuffer = Buffer.from(await res.arrayBuffer());
    log.ok(`Фото скачано (${(photoBuffer.length / 1024).toFixed(1)} KB)`);
  }

  let lastUpdate = Date.now();

  for (const userId of state.userIds) {
    if (currentMailing.stopped) {
      log.mail(`Рассылка остановлена вручную на ${currentMailing.sent + currentMailing.errors}/${currentMailing.total}`);
      break;
    }

    let retries = 2;
    let delivered = false;
    while (retries > 0) {
      try {
        const replyMarkup = buildInlineKeyboard(state.inlineButtons);
        if (state.msg.type === "photo" && photoBuffer) {
          const photoSource = cachedPhotoFileId ?? new InputFile(photoBuffer, "photo.jpg");
          const sent = await targetApi.sendPhoto(userId, photoSource, {
            caption: state.msg.caption,
            caption_entities: state.msg.captionEntities,
            reply_markup: replyMarkup,
          });
          if (!cachedPhotoFileId) {
            cachedPhotoFileId = sent.photo.at(-1)?.file_id;
            log.ok(`Фото загружено в Telegram для целевого бота (file_id получен)`);
          }
        } else if (state.msg.text) {
          await targetApi.sendMessage(userId, state.msg.text, {
            entities: state.msg.entities,
            reply_markup: replyMarkup,
          });
        }
        currentMailing.sent++;
        delivered = true;
        log.ok(`  → ${userId} — отправлено (${currentMailing.sent}/${currentMailing.total})`);
        break;
      } catch (err: any) {
        if (err?.error_code === 429) {
          const wait = ((err?.parameters?.retry_after ?? 5) + 1) * 1000;
          log.warn(`FloodWait ${wait / 1000}s для ${userId} — ждём...`);
          await new Promise((r) => setTimeout(r, wait));
          retries--;
        } else {
          currentMailing.errors++;
          log.error(`  → ${userId} — ошибка: ${err?.description ?? err?.message ?? "unknown"}`);
          break;
        }
      }
    }
    if (!delivered && retries === 0) {
      currentMailing.errors++;
      log.error(`  → ${userId} — исчерпаны попытки FloodWait, пропущен`);
    }

    if (Date.now() - lastUpdate >= 1000) {
      lastUpdate = Date.now();
      await bot.api
        .editMessageText(chatId, msgId, getProgressText(currentMailing), {
          parse_mode: "HTML",
          reply_markup: progressKeyboard(currentMailing),
        })
        .catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  log.mail(`Рассылка завершена | отправлено: ${currentMailing.sent} | ошибок: ${currentMailing.errors}`);
  await bot.api
    .editMessageText(chatId, msgId, getProgressText(currentMailing, true), {
      parse_mode: "HTML",
      reply_markup: progressKeyboard(currentMailing),
    })
    .catch(() => {});
  currentMailing = null;
}

async function sendPreview(chatId: number, msg: StoredMessage, buttons: ParsedButton[], botId: number) {
  const replyMarkup = buildInlineKeyboard(buttons);
  if (msg.type === "photo" && msg.photoFileId) {
    await bot.api.sendPhoto(chatId, msg.photoFileId, {
      caption: msg.caption,
      caption_entities: msg.captionEntities,
      reply_markup: replyMarkup,
    });
  } else if (msg.text) {
    await bot.api.sendMessage(chatId, msg.text, {
      entities: msg.entities,
      reply_markup: replyMarkup,
    });
  }
  await bot.api.sendMessage(chatId, "Предпросмотр текста", {
    reply_markup: new InlineKeyboard().add({
      text: "Назад",
      callback_data: `mailing_back_confirm_${botId}`,
      icon_custom_emoji_id: "5258236805890710909",
    }),
  });
}

async function validateBotToken(botToken: string): Promise<{ name: string; username: string } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { first_name: string; username: string } };
    if (data.ok && data.result) return { name: data.result.first_name, username: data.result.username };
    return null;
  } catch {
    return null;
  }
}

function getStartKeyboard() {
  return new InlineKeyboard()
    .add({ text: "Панель", callback_data: "panel", icon_custom_emoji_id: "5258391025281408576" }).row()
    .add({ text: "Подключить бота", callback_data: "connect_bot", icon_custom_emoji_id: "5258093637450866522" });
}

function getConnectKeyboard() {
  return new InlineKeyboard().add({
    text: "Назад (Отмена)",
    callback_data: "back_to_start",
    icon_custom_emoji_id: "5258236805890710909",
  });
}

function getPanelKeyboard() {
  const bots = botsDb.getAll();
  const kb = new InlineKeyboard();
  if (bots.length === 0) {
    kb.text("Пусто", "noop").row();
  } else {
    for (const b of bots) {
      kb.text(`${b.name} (@${b.username})`, `bot_${b.id}`).row();
    }
  }
  kb.add({ text: "Назад", callback_data: "back_to_start", icon_custom_emoji_id: "5258236805890710909" });
  return kb;
}

function getBotKeyboard(id: number) {
  return new InlineKeyboard()
    .add({ text: "Рассылка", callback_data: `mailing_${id}`, icon_custom_emoji_id: "5260535596941582167" }).row()
    .add({ text: "Удалить подключение", callback_data: `delete_${id}`, icon_custom_emoji_id: "5258130763148172425" }).row()
    .add({ text: "Назад", callback_data: "panel", icon_custom_emoji_id: "5258236805890710909" });
}

function getMailingFileKeyboard(botId: number) {
  return new InlineKeyboard()
    .add({ text: "Взять из локального хранилища", callback_data: `mailing_local_${botId}`, icon_custom_emoji_id: "5258514780469075716" }).row()
    .add({ text: "Назад", callback_data: `bot_${botId}`, icon_custom_emoji_id: "5258236805890710909" });
}

function getMailingMessageKeyboard(botId: number) {
  return new InlineKeyboard().add({
    text: "Назад",
    callback_data: `mailing_back_file_${botId}`,
    icon_custom_emoji_id: "5258236805890710909",
  });
}

function getMailingConfirmKeyboard(botId: number) {
  return new InlineKeyboard()
    .add({ text: "Запустить", callback_data: `mailing_launch_${botId}`, icon_custom_emoji_id: "5260726538302660868" }).row()
    .add({ text: "Посмотреть текст", callback_data: `mailing_preview_${botId}`, icon_custom_emoji_id: "5258450450448915742" }).row()
    .add({ text: "Добавить Inline", callback_data: `mailing_inline_${botId}`, icon_custom_emoji_id: "5274008024585871702" }).row()
    .add({ text: "Назад", callback_data: `mailing_back_msg_${botId}`, icon_custom_emoji_id: "5258236805890710909" });
}

function getMailingInlineKeyboard(botId: number) {
  return new InlineKeyboard().add({
    text: "Назад",
    callback_data: `mailing_back_confirm_${botId}`,
    icon_custom_emoji_id: "5258236805890710909",
  });
}

function getBotText(b: BotRecord) {
  return `<b><tg-emoji emoji-id="5258093637450866522">🤖</tg-emoji>  Бот: </b>${b.name} <b>(@${b.username})</b>\n\n<b>Статус:</b> ${b.status}`;
}

bot.command("start", async (ctx) => {
  log.cmd("/start");
  waitingForToken = false;
  mailingState = null;
  await ctx.reply(
    `<b><tg-emoji emoji-id="5258501105293205250">👏</tg-emoji> Привет! Как твои дела?</b>`,
    { parse_mode: "HTML", reply_markup: getStartKeyboard() }
  );
});

bot.command("panel", async (ctx) => {
  log.cmd("/panel");
  await ctx.reply(
    `<b><tg-emoji emoji-id="5258328383183396223">📖</tg-emoji> Список Ваших ботов:</b>`,
    { parse_mode: "HTML", reply_markup: getPanelKeyboard() }
  );
});

bot.command("connect", async (ctx) => {
  log.cmd("/connect");
  waitingForToken = true;
  await ctx.reply(
    `<b><tg-emoji emoji-id="5258514780469075716">📂</tg-emoji> Отправь мне токен бота:</b>`,
    { parse_mode: "HTML", reply_markup: getConnectKeyboard() }
  );
});

bot.callbackQuery("panel", async (ctx) => {
  log.cb("Панель");
  mailingState = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5258328383183396223">📖</tg-emoji> Список Ваших ботов:</b>`,
    { parse_mode: "HTML", reply_markup: getPanelKeyboard() }
  );
});

bot.callbackQuery("connect_bot", async (ctx) => {
  log.cb("Подключить бота");
  waitingForToken = true;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5258514780469075716">📂</tg-emoji> Отправь мне токен бота:</b>`,
    { parse_mode: "HTML", reply_markup: getConnectKeyboard() }
  );
});

bot.callbackQuery("back_to_start", async (ctx) => {
  log.cb("Назад → главное меню");
  waitingForToken = false;
  mailingState = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5258501105293205250">👏</tg-emoji> Привет! Как твои дела?</b>`,
    { parse_mode: "HTML", reply_markup: getStartKeyboard() }
  );
});

bot.callbackQuery(/^bot_(\d+)$/, async (ctx) => {
  mailingState = null;
  const id = Number(ctx.match[1]);
  const b = botsDb.getById(id);
  if (!b) {
    log.warn(`Открытие бота id=${id} — не найден в БД`);
    await ctx.answerCallbackQuery("Бот не найден");
    return;
  }
  log.cb(`Открыт бот: @${b.username} (id=${id})`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(getBotText(b), { parse_mode: "HTML", reply_markup: getBotKeyboard(id) });
});

bot.callbackQuery(/^delete_(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const b = botsDb.getById(id);
  botsDb.remove(id);
  log.cb(`Удалён бот id=${id}${b ? ` (@${b.username})` : ""}`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5258328383183396223">📖</tg-emoji> Список Ваших ботов:</b>`,
    { parse_mode: "HTML", reply_markup: getPanelKeyboard() }
  );
});

bot.callbackQuery(/^mailing_(\d+)$/, async (ctx) => {
  const botId = Number(ctx.match[1]);
  mailingState = { step: "file", botId, userIds: [], inlineButtons: [] };
  log.cb(`Рассылка → шаг: загрузка файла (botId=${botId})`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5260535596941582167">📂</tg-emoji> Отправьте .txt файл с ID пользователей в чат:</b>`,
    { parse_mode: "HTML", reply_markup: getMailingFileKeyboard(botId) }
  );
});

bot.callbackQuery(/^mailing_back_file_(\d+)$/, async (ctx) => {
  const botId = Number(ctx.match[1]);
  if (mailingState) mailingState.step = "file";
  else mailingState = { step: "file", botId, userIds: [], inlineButtons: [] };
  log.cb(`Рассылка → назад к загрузке файла (botId=${botId})`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5260535596941582167">📂</tg-emoji> Отправьте .txt файл с ID пользователей в чат:</b>`,
    { parse_mode: "HTML", reply_markup: getMailingFileKeyboard(botId) }
  );
});

bot.callbackQuery(/^mailing_local_(\d+)$/, async (ctx) => {
  const botId = Number(ctx.match[1]);
  const filePath = path.join(process.cwd(), "telegram.txt");
  log.cb(`Рассылка → загрузка из локального файла (botId=${botId})`);

  if (!fs.existsSync(filePath)) {
    log.warn(`Файл telegram.txt не найден по пути: ${filePath}`);
    await ctx.answerCallbackQuery("❌ Файл telegram.txt не найден в директории бота");
    return;
  }

  const text = fs.readFileSync(filePath, "utf-8");
  const userIds = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);

  if (userIds.length === 0) {
    log.warn("telegram.txt пустой или не содержит валидных ID");
    await ctx.answerCallbackQuery("❌ Файл пустой или не содержит ID пользователей");
    return;
  }

  if (!mailingState) mailingState = { step: "file", botId, userIds: [], inlineButtons: [] };
  mailingState.userIds = userIds;
  mailingState.step = "message";
  mailingState.botId = botId;

  log.ok(`Загружено ${userIds.length} ID из локального telegram.txt`);
  await ctx.answerCallbackQuery(`Загружено ${userIds.length} айжи`);
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5359719332542718652">💎</tg-emoji> Введите текст отправки</b> <i>(Вы можете отправить его уже в формате или использовать HTML и с фотографиями)</i>:`,
    { parse_mode: "HTML", reply_markup: getMailingMessageKeyboard(botId) }
  );
});

bot.callbackQuery(/^mailing_back_msg_(\d+)$/, async (ctx) => {
  if (!mailingState) return;
  mailingState.step = "message";
  log.cb(`Рассылка → назад к вводу сообщения (botId=${mailingState.botId})`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b><tg-emoji emoji-id="5258215635996908355">📂</tg-emoji> Введите текст отправки</b> <i>(Вы можете отправить его уже в формате или использовать HTML и с фотографиями)</i>:`,
    { parse_mode: "HTML", reply_markup: getMailingMessageKeyboard(mailingState.botId) }
  );
});

bot.callbackQuery(/^mailing_back_confirm_(\d+)$/, async (ctx) => {
  if (!mailingState) return;
  mailingState.step = "confirm";
  log.cb(`Рассылка → назад к подтверждению (botId=${mailingState.botId})`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b>Вы уверены в запуске рассылки?</b>\n\n<b>Пользователей:</b> ${mailingState.userIds.length}`,
    { parse_mode: "HTML", reply_markup: getMailingConfirmKeyboard(mailingState.botId) }
  );
});

bot.callbackQuery(/^mailing_inline_(\d+)$/, async (ctx) => {
  if (!mailingState) return;
  mailingState.step = "inline";
  log.cb(`Рассылка → добавление Inline кнопок (botId=${mailingState.botId})`);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b>Укажите кнопки:</b>\n\n<i>Пример:</i>\n<code>URL - t.me/inversia89 - test</code>\n<code>COPY - copy - text</code>`,
    { parse_mode: "HTML", reply_markup: getMailingInlineKeyboard(mailingState.botId) }
  );
});

bot.callbackQuery(/^mailing_preview_(\d+)$/, async (ctx) => {
  if (!mailingState?.msg) { await ctx.answerCallbackQuery("Нет сообщения"); return; }
  log.cb(`Рассылка → предпросмотр (botId=${mailingState.botId})`);
  await ctx.answerCallbackQuery();
  await sendPreview(ctx.chat!.id, mailingState.msg, mailingState.inlineButtons, mailingState.botId);
});

bot.callbackQuery(/^mailing_launch_(\d+)$/, async (ctx) => {
  if (!mailingState?.msg) { await ctx.answerCallbackQuery("Нет сообщения для рассылки"); return; }
  log.cb(`Рассылка → запуск (botId=${mailingState.botId}, пользователей: ${mailingState.userIds.length})`);
  const msgId = ctx.callbackQuery.message!.message_id;
  const state = { ...mailingState };
  mailingState = null;

  currentMailing = { total: state.userIds.length, sent: 0, errors: 0, stopped: false };
  await ctx.editMessageText(getProgressText(currentMailing), {
    parse_mode: "HTML",
    reply_markup: progressKeyboard(currentMailing),
  });
  await ctx.answerCallbackQuery();

  runMailing(state, ctx.chat!.id, msgId).catch((err) => log.error(`runMailing: ${err?.message}`));
});

bot.callbackQuery("mailing_stop", async (ctx) => {
  if (currentMailing) {
    currentMailing.stopped = true;
    log.mail("Stop получен — рассылка будет остановлена");
  }
  await ctx.answerCallbackQuery("Останавливаем...");
});

bot.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

bot.on("message:document", async (ctx) => {
  if (!mailingState || mailingState.step !== "file") return;

  const fileName = ctx.message.document.file_name ?? "";
  log.msg(`Получен документ: ${fileName}`);

  if (!fileName.endsWith(".txt")) {
    log.warn(`Файл ${fileName} — не .txt, отклонён`);
    await ctx.reply(
      '<b><tg-emoji emoji-id="5260342697075416641">❌</tg-emoji> Пожалуйста, отправьте .txt файл.</b>',
      { parse_mode: "HTML" }
    );
    return;
  }

  const file = await ctx.getFile();
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  const text = await res.text();

  const userIds = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);

  if (userIds.length === 0) {
    log.warn("Файл не содержит валидных ID");
    await ctx.reply('<b><tg-emoji emoji-id="5260342697075416641">❌</tg-emoji> Файл пустой или не содержит ID пользователей.</b>',
     { parse_mode: "HTML"}
    );
    return;
  }

  log.ok(`Загружено ${userIds.length} ID из файла ${fileName}`);
  mailingState.userIds = userIds;
  mailingState.step = "message";

  await ctx.reply(
    `<b><tg-emoji emoji-id="5359719332542718652">💎</tg-emoji> Введите текст отправки</b> <i>(Вы можете отправить его уже в формате или использовать HTML и с фотографиями)</i>:`,
    { parse_mode: "HTML", reply_markup: getMailingMessageKeyboard(mailingState.botId) }
  );
});

bot.on("message:photo", async (ctx) => {
  if (mailingState?.step !== "message") return;
  const photo = ctx.message.photo.at(-1)!;
  log.msg(`Получено фото для рассылки (file_id: ${photo.file_id.slice(0, 20)}...)`);
  mailingState.msg = {
    type: "photo",
    photoFileId: photo.file_id,
    caption: ctx.message.caption,
    captionEntities: ctx.message.caption_entities as any[],
  };
  mailingState.step = "confirm";
  await ctx.reply(
    `<b><tg-emoji emoji-id="5260268501515377807">📣</tg-emoji> Вы уверены в запуске рассылки?</b>\n\n<b>Пользователей:</b> ${mailingState.userIds.length}`,
    { parse_mode: "HTML", reply_markup: getMailingConfirmKeyboard(mailingState.botId) }
  );
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  if (mailingState?.step === "message") {
    log.msg(`Получен текст рассылки (${text.length} симв.)`);
    mailingState.msg = { type: "text", text, entities: ctx.message.entities as any[] };
    mailingState.step = "confirm";
    await ctx.reply(
      `<b><tg-emoji emoji-id="5260268501515377807">📣</tg-emoji> Вы уверены в запуске рассылки?</b>\n\n<b>Пользователей:</b> ${mailingState.userIds.length}`,
      { parse_mode: "HTML", reply_markup: getMailingConfirmKeyboard(mailingState.botId) }
    );
    return;
  }

  if (mailingState?.step === "inline") {
    const buttons = parseButtons(text);
    log.msg(`Получены Inline кнопки: ${buttons.length} шт. — ${buttons.map((b) => `[${b.type}:${b.label}]`).join(", ")}`);
    mailingState.inlineButtons = buttons;
    mailingState.step = "confirm";
    await ctx.reply(
      `<b><tg-emoji emoji-id="5260268501515377807">📣</tg-emoji> Вы уверены в запуске рассылки?</b>\n\n<b>Пользователей:</b> ${mailingState.userIds.length}`,
      { parse_mode: "HTML", reply_markup: getMailingConfirmKeyboard(mailingState.botId) }
    );
    return;
  }

  if (!waitingForToken) return;

  log.msg("Получен токен бота, проверяю...");
  const botToken = text.trim();
  const info = await validateBotToken(botToken);

  if (!info) {
    log.warn("Токен невалидный");
    await ctx.reply(
      `<b><tg-emoji emoji-id="5260342697075416641">❌</tg-emoji> Неверный токен. Попробуй ещё раз.</b>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().add({
          text: "Отмена",
          callback_data: "back_to_start",
          icon_custom_emoji_id: "5258236805890710909",
        }),
      }
    );
    return;
  }

  if (botsDb.findByToken(botToken)) {
    log.warn(`Бот @${info.username} уже подключён`);
    await ctx.reply(
      `<b><tg-emoji emoji-id="5260730055880876557">⛓</tg-emoji> Этот бот уже подключён.</b>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  botsDb.add(botToken, info.username, info.name);
  waitingForToken = false;
  log.ok(`Бот подключён: ${info.name} (@${info.username})`);
  await ctx.deleteMessage();
  await ctx.reply(
    `<b><tg-emoji emoji-id="5258185631355378853">⭐️</tg-emoji> Бот ${info.name} с юзернеймом @${info.username} подключен.</b>`,
    { parse_mode: "HTML" }
  );
});

bot.catch((err) => {
  log.error(`Необработанная ошибка: ${err.message}`);
});

bot.start({
  onStart: () => log.ok(`Бот запущен. Owner IDs: ${OWNER_IDS.join(", ")}`),
});
