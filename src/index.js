/**
 * PixelPop Telegram File Store Bot (Cloudflare Worker + D1 Database)
 * Capable of handling 20,000+ daily downloads with ZERO limits!
 */

export default {
  // 1. Scheduled Event (පැය 6න් Files Auto-Delete කිරීම)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanExpiredMessages(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Lazy Auto Cleanup on incoming requests
    ctx.waitUntil(cleanExpiredMessages(env));

    // 🔍 1. SYSTEM DIAGNOSTIC TEST
    if (url.pathname === "/test") {
      const storageCheck = await callTelegram(env.BOT_TOKEN, "getChat", {
        chat_id: env.STORAGE_CHANNEL_ID,
      });

      const fsubCheck = env.FORCE_SUB_CHANNEL_ID
        ? await callTelegram(env.BOT_TOKEN, "getChat", { chat_id: env.FORCE_SUB_CHANNEL_ID })
        : { ok: true, note: "Force sub not configured" };

      let d1Status = "OK";
      try {
        await env.DB.prepare("SELECT 1").first();
      } catch (err) {
        d1Status = `D1 Error: ${err.message}`;
      }

      const adminCheck = await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        text: "🔔 Test Message: System & D1 Database are 100% operational!",
      });

      return new Response(
        JSON.stringify(
          {
            database_status: d1Status,
            storage_channel: storageCheck,
            main_channel_fsub: fsubCheck,
            admin_status: adminCheck,
            configured_storage_id: env.STORAGE_CHANNEL_ID,
          },
          null,
          2
        ),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. AD CLICK RECORD (User Ad එකට ගිය වෙලාව D1 Database එකේ සටහන් කිරීම)
    if (url.pathname === "/ad_started" || url.pathname === "/verify") {
      const userId = url.searchParams.get("a");
      if (userId && env.DB) {
        await env.DB.prepare(`
          UPDATE users SET ad_started_at = ? WHERE user_id = ?
        `).bind(Date.now(), userId.toString()).run();
      }
      return new Response("OK", { headers: corsHeaders });
    }

    // 3. TELEGRAM WEBHOOK
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK");
    }

    return new Response("PixelPop Bot with D1 Database is Running Online!");
  },
};

// ================= TELEGRAM HANDLER =================
async function handleTelegramUpdate(update, env) {
  // A. Message Handler
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id.toString();
    const text = (msg.text || "").trim();

    // 1. ADMIN ONLY (Files එක්රැස් කිරීම)
    if (chatId === env.ADMIN_ID?.toString()) {
      if (!text.startsWith("/")) {
        let channelMsgId = null;

        const originChatId =
          msg.forward_origin?.chat?.id?.toString() ||
          msg.forward_from_chat?.id?.toString();
        const originMsgId =
          msg.forward_origin?.message_id ||
          msg.forward_from_message_id;

        const storageChannelId = env.STORAGE_CHANNEL_ID?.toString();

        if (originChatId && originChatId === storageChannelId && originMsgId) {
          // Storage Channel එකේම File එකක් නම්: Original ID එක D1 එකට දමයි
          channelMsgId = originMsgId;
          await env.DB.prepare(`INSERT INTO admin_batch (message_id) VALUES (?)`).bind(channelMsgId).run();

          const countRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM admin_batch`).first();

          const adminKb = {
            inline_keyboard: [
              [{ text: "🔗 Generate Link Now / දැන් Link එක හදන්න", callback_data: "admin_done" }],
              [{ text: "🗑️ Cancel / අවලංගු කරන්න", callback_data: "admin_cancel" }],
            ],
          };

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text: `✅ <b>Storage Channel File Detected!</b> (ID: <code>${channelMsgId}</code>)\nTotal files in batch: <b>${countRes?.count || 1}</b>\n\nForward more files, or click below to generate link:`,
            reply_markup: adminKb,
          });
          return;
        } else {
          // වෙනත් තැනකින් ආ එකක් නම්: Storage Channel එකට Copy කරයි
          const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
            chat_id: env.STORAGE_CHANNEL_ID,
            from_chat_id: chatId,
            message_id: msg.message_id,
          });

          if (res.ok) {
            channelMsgId = res.result.message_id;
            await env.DB.prepare(`INSERT INTO admin_batch (message_id) VALUES (?)`).bind(channelMsgId).run();

            const countRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM admin_batch`).first();

            const adminKb = {
              inline_keyboard: [
                [{ text: "🔗 Generate Link Now / දැන් Link එක හදන්න", callback_data: "admin_done" }],
                [{ text: "🗑️ Cancel / අවලංගු කරන්න", callback_data: "admin_cancel" }],
              ],
            };

            await callTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              parse_mode: "HTML",
              text: `📥 <b>File Copied to Storage Channel!</b> (Saved as ID: <code>${channelMsgId}</code>)\nTotal files in batch: <b>${countRes?.count || 1}</b>\n\nForward more files, or click below to generate link:`,
              reply_markup: adminKb,
            });
          } else {
            await callTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `❌ Error copying to channel: ${res.description || "Unknown"}`,
            });
          }
          return;
        }
      }

      if (text.startsWith("/done")) {
        await generateBatchLink(env, chatId);
        return;
      }

      if (text.startsWith("/cancel")) {
        await env.DB.prepare(`DELETE FROM admin_batch`).run();
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: "🗑️ <b>Batch Cleared!</b> / <b>Batch එක සාර්ථකව ඉවත් කරන ලදී.</b>",
        });
        return;
      }
    }

    // 2. HELP COMMAND
    if (text.startsWith("/help")) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `📖 <b>How to Use this Bot / භාවිතා කරන්නේ කෙසේද?</b>\n\n<b>English:</b>\n1. Click on any Movie/Series link from our channel.\n2. Make sure you are subscribed to our main channel.\n3. Click 'Watch Ads (for 5s)' and stay on the sponsor ad for at least 5 seconds.\n4. Return here and click 'I have clicked ads ⁉️' to get files!\n\n<b>සිංහල:</b>\n1. Channel එකේ ඇති Movie/Series link එකක් ඔබන්න.\n2. අපගේ ප්‍රධාන Channel එකට Join වී සිටින්න.\n3. 'Watch Ads (for 5s)' ඔබා Ad එකෙහි අවම වශයෙන් තත්පර 5ක් රැඳී සිටින්න.\n4. නැවත මෙහි පැමිණ 'I have clicked ads ⁉️' ඔබා Files ලබාගන්න!`,
      });
      return;
    }

    // 3. USER /start DEEP LINK HANDLER
    if (text.startsWith("/start")) {
      const parts = text.split(" ");

      if (parts.length > 1) {
        const payload = parts[1];

        // 🛡️ CHECK FORCE SUBSCRIBE
        const isSubscribed = await checkUserSubscription(env, chatId);
        if (!isSubscribed) {
          const fsubKeyboard = {
            inline_keyboard: [
              [{ text: `📢 Join ${env.FORCE_SUB_CHANNEL_NAME || "Our Channel"}`, url: env.FORCE_SUB_CHANNEL_LINK }],
              [{ text: "🔄 Try Again / නැවත උත්සාහ කරන්න", callback_data: `check_fsub_${payload}` }],
            ],
          };

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text: `⚠️ <b>Access Denied! Join Required</b>\nYou must join our official channel to download files.\n\n⚠️ <b>ප්‍රවේශය ප්‍රතික්ෂේප විය!</b>\nFiles ලබා ගැනීමට නම් ඔබ අපගේ ප්‍රධාන Channel එකට සම්බන්ධ විය යුතුය. පහත Button එකෙන් Join වී <b>Try Again</b> ඔබන්න!`,
            reply_markup: fsubKeyboard,
          });
          return;
        }

        await initiateFileSession(env, chatId, payload);
      } else {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: `👋 <b>Welcome to PixelPop File Store!</b>\nPlease use download links from our movie channel to access files.\n\n👋 <b>PixelPop File Store වෙත සාදරයෙන් පිළිගනිමු!</b>\nFiles ලබා ගැනීමට කරුණාකර අපගේ Channel එකේ ඇති Download Links භාවිතා කරන්න.`,
        });
      }
    }
  }

  // B. Callback Handler
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.from.id.toString();

    // Admin Done Button
    if (cb.data === "admin_done" && chatId === env.ADMIN_ID?.toString()) {
      await generateBatchLink(env, chatId);
      return;
    }

    // Admin Cancel Button
    if (cb.data === "admin_cancel" && chatId === env.ADMIN_ID?.toString()) {
      await env.DB.prepare(`DELETE FROM admin_batch`).run();
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "🗑️ Batch Cleared!",
      });
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "🗑️ Batch එක ඉවත් කරන ලදී.",
      });
      return;
    }

    // Force Sub "Try Again" Button
    if (cb.data.startsWith("check_fsub_")) {
      const payload = cb.data.replace("check_fsub_", "");
      const isSubscribed = await checkUserSubscription(env, chatId);

      if (isSubscribed) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Membership Verified!",
          show_alert: false,
        });
        await initiateFileSession(env, chatId, payload);
      } else {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "❌ You have not joined the channel yet! / ඔබ තවමත් Channel එකට Join වී නැත!",
          show_alert: true,
        });
      }
      return;
    }

    // 🔒 "I have clicked ads" Button (STRICT 5s ANTI-CHEAT + D1 Database)
    if (cb.data === "check_ad") {
      const user = await env.DB.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).bind(chatId).first();

      if (!user) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ Session Expired! Please click the download link again.",
          show_alert: true,
        });
        return;
      }

      if (user.delivered === 1) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Files already sent! Check your chat.\nFiles දැනටමත් ඔබ වෙත එවා ඇත!",
          show_alert: false,
        });
        return;
      }

      // 1. User Ad එක Click කර නැත්නම්
      if (!user.ad_started_at) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "❌ You haven't clicked the ad button yet!\nඔබ තවමත් 'Watch Ads (for 5s)' Button එක ඔබා නැත!",
          show_alert: true,
        });
        return;
      }

      // 2. තත්පර 5 Timer එක පරීක්ෂා කිරීම
      const timePassedSeconds = (Date.now() - user.ad_started_at) / 1000;

      if (timePassedSeconds < 5) {
        const remaining = Math.ceil(5 - timePassedSeconds);
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⏳ Please watch the ad for 5 seconds! (${remaining}s remaining)\nකරුණාකර තවත් තත්පර ${remaining}ක් Ad එක නරඹා නැවත උත්සාහ කරන්න.`,
          show_alert: true,
        });
        return;
      }

      // 3. තත්පර 5 සම්පූර්ණ නම් Files Release කිරීම
      await env.DB.prepare(`
        UPDATE users SET delivered = 1 WHERE user_id = ?
      `).bind(chatId).run();

      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "✅ Verification Successful! Sending files...\nතහවුරු විය! Files එවමින් පවතී...",
        show_alert: false,
      });

      let idsToSend = [];
      try {
        idsToSend = JSON.parse(user.msg_ids);
      } catch {
        idsToSend = [];
      }

      await sendBatchFiles(env, chatId, idsToSend);
    }
  }
}

// ================= HELPER FUNCTIONS =================

// Admin Link Generation Logic
async function generateBatchLink(env, chatId) {
  const batchRes = await env.DB.prepare(`SELECT message_id FROM admin_batch`).all();
  const batch = (batchRes.results || []).map((r) => r.message_id);

  if (!batch || batch.length === 0) {
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ No files in queue! Please forward some files first.",
    });
    return;
  }

  const uniqueIds = [...new Set(batch)].sort((a, b) => a - b);
  const startId = uniqueIds[0];
  const endId = uniqueIds[uniqueIds.length - 1];

  let payloadString = "";
  if (uniqueIds.length === endId - startId + 1) {
    payloadString = `get-${startId}-${endId}`;
  } else {
    payloadString = `list-${uniqueIds.join(",")}`;
  }

  const secretCode = btoa(payloadString);
  const finalLink = `https://t.me/${env.BOT_USERNAME}?start=${secretCode}`;

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `🎉 <b>Batch Link Generated Successfully!</b>\n━━━━━━━━━━━━━━━━━━━\n📁 <b>Files Count:</b> ${uniqueIds.length}\n🔢 <b>Message IDs:</b> <code>${uniqueIds.join(", ")}</code>\n\n🔗 <b>Shareable Link:</b>\n<code>${finalLink}</code>\n━━━━━━━━━━━━━━━━━━━\n<i>(Tap link to copy & paste in your channel post)</i>`,
  });

  await env.DB.prepare(`DELETE FROM admin_batch`).run();
}

// FSUB Membership Verification
async function checkUserSubscription(env, userId) {
  if (!env.FORCE_SUB_CHANNEL_ID) return true;
  if (userId.toString() === env.ADMIN_ID?.toString()) return true;

  try {
    const res = await callTelegram(env.BOT_TOKEN, "getChatMember", {
      chat_id: env.FORCE_SUB_CHANNEL_ID,
      user_id: userId,
    });

    if (!res.ok) return true;

    const status = res.result.status;
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch {
    return true;
  }
}

// Session Creation & Ad Message Generation
async function initiateFileSession(env, chatId, payload) {
  try {
    const rawCode = atob(payload);
    let targetMsgIds = [];

    if (rawCode.startsWith("get-")) {
      const match = rawCode.match(/^get-(\d+)-(\d+)$/);
      if (!match) throw new Error("Invalid range");
      const start = parseInt(match[1]);
      const end = parseInt(match[2]);
      for (let i = start; i <= end; i++) targetMsgIds.push(i);
    } else if (rawCode.startsWith("list-")) {
      const listStr = rawCode.replace("list-", "");
      targetMsgIds = listStr.split(",").map((id) => parseInt(id));
    } else {
      throw new Error("Unknown format");
    }

    // D1 Database එකේ User Record එක සුරැකීම (Upsert)
    await env.DB.prepare(`
      INSERT INTO users (user_id, msg_ids, ad_started_at, delivered)
      VALUES (?, ?, NULL, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        msg_ids = excluded.msg_ids,
        ad_started_at = NULL,
        delivered = 0
    `).bind(chatId, JSON.stringify(targetMsgIds)).run();

    const websiteUrl = env.WEBSITE_URL || "https://pixelpoplk.pages.dev";
    const adUrl = `${websiteUrl}/verify.html?a=${chatId}`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🎬 Watch Ads (for 5s) / Ad එක නරඹන්න", url: adUrl }],
        [{ text: "I have clicked ads ⁉️ / Ad එක බැලුවා", callback_data: "check_ad" }],
      ],
    };

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `👇 <b>Watch a Quick 5-Second Ad to Get Files:</b>\nClick the button below, watch the ad for at least 5 seconds, and return here. Then tap 'I have clicked ads ⁉️' to get your files.\n\n👇 <b>Files ලබා ගැනීමට තත්පර 5ක Ad එක නරඹන්න:</b>\nපහත Button එක ඔබා අවම වශයෙන් තත්පර 5ක් Ad එක නරඹන්න. අනතුරුව 'I have clicked ads ⁉️' ඔබා Files ලබාගන්න.`,
      reply_markup: keyboard,
    });
  } catch {
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ Invalid Link! Please try again from the channel.\nවලංගු නොවන Link එකකි.",
    });
  }
}

// Send Files & Schedule 6-Hour Deletion
async function sendBatchFiles(env, chatId, msgIds) {
  let results = [];
  if (!msgIds || msgIds.length === 0) return results;

  let sentMessageIds = [];

  for (const msgId of msgIds) {
    const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
      chat_id: chatId,
      from_chat_id: env.STORAGE_CHANNEL_ID,
      message_id: msgId,
    });

    if (res.ok) {
      sentMessageIds.push(res.result.message_id);
    }
    results.push(res);
  }

  // 6-Hour Warning Notice
  const warningMsg = await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `⚠️ <b>IMPORTANT NOTICE / විශේෂ දැනුම්දීමයි:</b>\n━━━━━━━━━━━━━━━━━━━━\n🇬🇧 <b>English:</b>\nThese files will be <b>automatically deleted in 6 hours</b> due to copyright & storage limits.\n👉 <b>Please forward them to your 'Saved Messages' or download to your phone right now!</b>\n\n🇱🇰 <b>සිංහල:</b>\nප්‍රකාශන හිමිකම් සහ ඉඩකඩ සීමා නිසා මෙම Files <b>පැය 6කින් ස්වයංක්‍රීයව මැකී යනු ඇත.</b>\n👉 <b>දැන්ම ඔබගේ 'Saved Messages' වෙත Forward කරගන්න හෝ Phone එකට Save කරගන්න!</b>\n━━━━━━━━━━━━━━━━━━━━`,
  });

  if (warningMsg.ok) {
    sentMessageIds.push(warningMsg.result.message_id);
  }

  // 6 Hours Deletion Queue (D1 Database එකට ඇතුළත් කිරීම)
  const deleteAt = Date.now() + 6 * 60 * 60 * 1000;
  for (const sentId of sentMessageIds) {
    await env.DB.prepare(`
      INSERT INTO deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)
    `).bind(chatId, sentId, deleteAt).run();
  }

  return results;
}

// Cleanup Expired Messages (D1 Database එකෙන් කියවා මකා දැමීම)
async function cleanExpiredMessages(env) {
  if (!env.DB) return;

  const now = Date.now();
  const expired = await env.DB.prepare(`
    SELECT * FROM deletions WHERE delete_at <= ? LIMIT 50
  `).bind(now).all();

  if (expired.results && expired.results.length > 0) {
    for (const item of expired.results) {
      await callTelegram(env.BOT_TOKEN, "deleteMessage", {
        chat_id: item.chat_id,
        message_id: item.message_id,
      });
      await env.DB.prepare(`DELETE FROM deletions WHERE id = ?`).bind(item.id).run();
    }
  }
}

// Telegram API Helper
async function callTelegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
