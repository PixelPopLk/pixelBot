/**
 * PixelPop Telegram File Store Bot (Cloudflare Worker)
 * Production Ready - 100% Fixed Full Code
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Cross-Origin Headers (Website එකට Access දීම සඳහා)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 🔍 1. SYSTEM TEST ENDPOINT (පරීක්ෂා කිරීම සඳහා)
    if (url.pathname === "/test") {
      const channelCheck = await callTelegram(env.BOT_TOKEN, "getChat", {
        chat_id: env.STORAGE_CHANNEL_ID,
      });

      const adminCheck = await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        text: "🔔 Test Message: Bot ට ඔයාට Messages එවන්න පුළුවන්!",
      });

      return new Response(
        JSON.stringify(
          {
            channel_status: channelCheck,
            admin_status: adminCheck,
            configured_channel_id: env.STORAGE_CHANNEL_ID,
            configured_admin_id: env.ADMIN_ID,
          },
          null,
          2
        ),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. WEBSITE VERIFY ENDPOINT (Ad එක බැලූ පසු Files යවන තැන)
    if (url.pathname === "/verify") {
      const userId = url.searchParams.get("a");
      if (!userId) {
        return new Response("Missing user ID", { status: 400, headers: corsHeaders });
      }

      const userKey = `user_${userId}`;
      const userData = await env.BOT_KV.get(userKey, { type: "json" });

      if (userData) {
        // A. මුලින්ම User ව Verified ලෙස Save කරගනී
        userData.verified = true;
        await env.BOT_KV.put(userKey, JSON.stringify(userData), { expirationTtl: 3600 });

        // B. Files Message IDs සොයා ගැනීම (පරණ සහ අලුත් Format දෙකටම වැඩ කරයි)
        let idsToSend = userData.msgIds;
        if (!idsToSend && userData.startMsg && userData.endMsg) {
          idsToSend = [];
          for (let i = userData.startMsg; i <= userData.endMsg; i++) idsToSend.push(i);
        }

        let tgResults = [];
        // C. Files තවමත් Chat එකට ගොස් නැත්නම් ක්ෂණිකව යැවීම
        if (!userData.delivered && idsToSend && idsToSend.length > 0) {
          userData.delivered = true;
          tgResults = await sendBatchFiles(env, userId, idsToSend);
          await env.BOT_KV.put(userKey, JSON.stringify(userData), { expirationTtl: 3600 });
        }

        return new Response(
          JSON.stringify({ status: "success", verified: true, delivered: userData.delivered, telegram_response: tgResults }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      return new Response("Pending session not found", { status: 404, headers: corsHeaders });
    }

    // 3. TELEGRAM WEBHOOK (පණිවිඩ කළමනාකරණය)
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK");
    }

    return new Response("Bot Server is Running Online!");
  },
};

// ================= TELEGRAM HANDLER =================
async function handleTelegramUpdate(update, env) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id.toString();
    const text = msg.text || "";

    // 1. ADMIN ONLY ACTIONS (Files එකතු කිරීම සහ Links සෑදීම)
    if (chatId === env.ADMIN_ID.toString()) {
      // A. Files Forward / Upload කළ විට Handle කිරීම
      if (!text.startsWith("/")) {
        let channelMsgId = null;

        // පරීක්ෂා කිරීම: File එක දැනටමත් Storage Channel එකෙන් Forward කරපු එකක්ද?
        const originChatId =
          msg.forward_origin?.chat?.id?.toString() ||
          msg.forward_from_chat?.id?.toString();
        const originMsgId =
          msg.forward_origin?.message_id ||
          msg.forward_from_message_id;

        const storageChannelId = env.STORAGE_CHANNEL_ID.toString();

        if (originChatId && originChatId === storageChannelId && originMsgId) {
          // දැනටමත් Channel එකේ තියෙන එකක් නම්: නැවත Copy නොකර කෙලින්ම Message ID එක ගනී!
          channelMsgId = originMsgId;
          let batch = (await env.BOT_KV.get("admin_batch", { type: "json" })) || [];
          batch.push(channelMsgId);
          await env.BOT_KV.put("admin_batch", JSON.stringify(batch), { expirationTtl: 86400 });

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `✅ Storage Channel එකේ File එකක් අඳුනාගත්තා! (Message ID: ${channelMsgId})\nතව Files එවන්න හෝ අවසන් වූ පසු /done යවන්න.`,
          });
          return;
        } else {
          // වෙනත් තැනකින් ආ එකක් නම්: Storage Channel එකට Auto-Copy කරයි!
          const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
            chat_id: env.STORAGE_CHANNEL_ID,
            from_chat_id: chatId,
            message_id: msg.message_id,
          });

          if (res.ok) {
            channelMsgId = res.result.message_id;
            let batch = (await env.BOT_KV.get("admin_batch", { type: "json" })) || [];
            batch.push(channelMsgId);
            await env.BOT_KV.put("admin_batch", JSON.stringify(batch), { expirationTtl: 86400 });

            await callTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `📥 File එක Channel එකට Copy කරන ලදී! (Saved as ID: ${channelMsgId})\nතව Files එවන්න හෝ අවසන් වූ පසු /done යවන්න.`,
            });
          } else {
            await callTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `❌ File එක Channel එකට දාන්න බැරි උනා!\nහේතුව: ${res.description || "Unknown error"}`,
            });
          }
          return;
        }
      }

      // B. Admin /done එබූ විට Link එක සකස් කිරීම
      if (text === "/done") {
        const batch = await env.BOT_KV.get("admin_batch", { type: "json" });

        if (!batch || batch.length === 0) {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "⚠️ ඔබ තවමත් Files කිසිවක් Bot වෙත Forward කර නොමැත!",
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
          parse_mode: "Markdown",
          text: `✅ *Batch Link Created Successfully!*\n\n📁 *Total Files:* ${uniqueIds.length}\n🔢 *Message IDs:* ${uniqueIds.join(", ")}\n\n🔗 *Your Link:*\n\`${finalLink}\`\n\n_(Link එක මත Click කර Copy කරගන්න)_`,
        });

        await env.BOT_KV.delete("admin_batch");
        return;
      }

      // C. Queue එක Cancel කිරීමට /cancel
      if (text === "/cancel") {
        await env.BOT_KV.delete("admin_batch");
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "🗑️ Batch එක සාර්ථකව ඉවත් කරන ලදී.",
        });
        return;
      }
    }

    // 2. USER /start DEEP LINK HANDLER
    if (text.startsWith("/start")) {
      const parts = text.split(" ");

      if (parts.length > 1) {
        try {
          const rawCode = atob(parts[1]); // Decode Base64
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

          // User Session එක KV එකේ Save කිරීම
          await env.BOT_KV.put(
            `user_${chatId}`,
            JSON.stringify({
              msgIds: targetMsgIds,
              timestamp: Date.now(),
              verified: false,
              delivered: false,
            }),
            { expirationTtl: 3600 }
          );

          const websiteUrl = env.WEBSITE_URL || "https://pixelpoplk.pages.dev";
          const adUrl = `${websiteUrl}/verify.html?a=${chatId}`;

          const keyboard = {
            inline_keyboard: [
              [{ text: "Watch Ads (for 5s) 🎬", url: adUrl }],
              [{ text: "I have clicked ads ⁉️", callback_data: "check_ad" }],
            ],
          };

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "👇 **පහත Button එක Click කර තත්පර 5ක Ad එක නරඹා Files ලබාගන්න:**",
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
        } catch {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "❌ වලංගු නොවන ලින්ක් එකකි. කරුණාකර Channel එකෙන් නැවත පැමිණෙන්න.",
          });
        }
      } else {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "👋 Welcome to PixelPop Bot!\n\nකරුණාකර Channel එකේ ඇති Download Links හරහා පැමිණෙන්න.",
        });
      }
    }
  }

  // B. "I have clicked ads" CALLBACK HANDLER (Manual Fallback)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.from.id.toString();

    if (cb.data === "check_ad") {
      const userKey = `user_${chatId}`;
      const data = await env.BOT_KV.get(userKey, { type: "json" });

      if (!data) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ Session එක කල් ඉකුත් වී ඇත. කරුණාකර /start නැවත ඔබන්න.",
          show_alert: true,
        });
        return;
      }

      if (data.delivered === true) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Files දැනටමත් ඔබගේ Chat එකට යවා ඇත!",
          show_alert: false,
        });
        return;
      }

      if (data.verified === true) {
        data.delivered = true;
        await env.BOT_KV.put(userKey, JSON.stringify(data), { expirationTtl: 3600 });

        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Verification සාර්ථකයි! Files එවමින් පවතී...",
          show_alert: false,
        });

        let idsToSend = data.msgIds;
        if (!idsToSend && data.startMsg && data.endMsg) {
          idsToSend = [];
          for (let i = data.startMsg; i <= data.endMsg; i++) idsToSend.push(i);
        }

        await sendBatchFiles(env, chatId, idsToSend);
      } else {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "❌ ඔබ තවමත් Ad එක නරඹා නැත! කරුණාකර තත්පර 5ක් සම්පූර්ණයෙන් නරඹා නැවත උත්සාහ කරන්න.",
          show_alert: true,
        });
      }
    }
  }
}

// Storage Channel එකෙන් Files ටික User ට යැවීම
async function sendBatchFiles(env, chatId, msgIds) {
  let results = [];
  if (!msgIds || msgIds.length === 0) return results;

  for (const msgId of msgIds) {
    const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
      chat_id: chatId,
      from_chat_id: env.STORAGE_CHANNEL_ID,
      message_id: msgId,
    });
    results.push(res);
  }
  return results;
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
