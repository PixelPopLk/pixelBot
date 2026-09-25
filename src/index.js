/**
 * PixelPop Telegram File Store Bot (Cloudflare Worker)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Cross-Origin Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 🔍 1. TEST ENDPOINT (ලෙඩේ හොයන කොටස)
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

    // 2. Website එකෙන් Verify Signal එක එන Endpoint එක
    if (url.pathname === "/verify") {
      const userId = url.searchParams.get("a");
      if (!userId) {
        return new Response("Missing user ID", { status: 400, headers: corsHeaders });
      }

      const userKey = `user_${userId}`;
      const userData = await env.BOT_KV.get(userKey, { type: "json" });

      if (userData) {
        userData.verified = true;
        let tgResults = [];

        // Auto Delivery: User ආපසු Telegram එකට එද්දී Files යවා තිබීම
        if (!userData.delivered) {
          userData.delivered = true;
          tgResults = await sendBatchFiles(env, userId, userData.startMsg, userData.endMsg);
        }

        await env.BOT_KV.put(userKey, JSON.stringify(userData), { expirationTtl: 3600 });
        return new Response(
          JSON.stringify({ status: "success", delivered: true, telegram_response: tgResults }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      return new Response("Pending session not found", { status: 404, headers: corsHeaders });
    }

    // 3. Telegram Webhook Updates
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

    // 1. Admin Features (Files Forward කර /done ගැසීම)
    if (chatId === env.ADMIN_ID.toString()) {
      if (msg.document || msg.video || msg.audio || msg.photo) {
        const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
          chat_id: env.STORAGE_CHANNEL_ID,
          from_chat_id: chatId,
          message_id: msg.message_id,
        });

        if (res.ok) {
          const channelMsgId = res.result.message_id;
          let batch = (await env.BOT_KV.get("admin_batch", { type: "json" })) || [];
          batch.push(channelMsgId);
          await env.BOT_KV.put("admin_batch", JSON.stringify(batch), { expirationTtl: 86400 });

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `📥 File received! (Saved as ID: ${channelMsgId})\nතව Files එවන්න හෝ අවසන් වූ පසු /done යවන්න.`,
          });
        }
        return;
      }

      if (text === "/done") {
        const batch = await env.BOT_KV.get("admin_batch", { type: "json" });

        if (!batch || batch.length === 0) {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "⚠️ ඔබ තවමත් Files කිසිවක් Bot වෙත Forward කර නොමැත!",
          });
          return;
        }

        const startId = Math.min(...batch);
        const endId = Math.max(...batch);
        const secretCode = btoa(`get-${startId}-${endId}`);
        const finalLink = `https://t.me/${env.BOT_USERNAME}?start=${secretCode}`;

        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "Markdown",
          text: `✅ *Batch Link Created Successfully!*\n\n📁 *Files Count:* ${batch.length}\n🔢 *Range:* ${startId} to ${endId}\n\n🔗 *Your Link:*\n\`${finalLink}\`\n\n_(Link එක උඩ Click කර Copy කරගන්න)_`,
        });

        await env.BOT_KV.delete("admin_batch");
        return;
      }

      if (text === "/cancel") {
        await env.BOT_KV.delete("admin_batch");
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "🗑️ Batch එක ඉවත් කරන ලදී.",
        });
        return;
      }
    }

    // 2. User /start Command
    if (text.startsWith("/start")) {
      const parts = text.split(" ");

      if (parts.length > 1) {
        try {
          const rawCode = atob(parts[1]);
          const match = rawCode.match(/^get-(\d+)-(\d+)$/);

          if (!match) throw new Error("Invalid format");

          const startMsg = parseInt(match[1]);
          const endMsg = parseInt(match[2]);

          await env.BOT_KV.put(
            `user_${chatId}`,
            JSON.stringify({
              startMsg,
              endMsg,
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

  // B. "I have clicked ads" Callback
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

        await sendBatchFiles(env, chatId, data.startMsg, data.endMsg);
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
async function sendBatchFiles(env, chatId, startMsg, endMsg) {
  let results = [];
  for (let msgId = startMsg; msgId <= endMsg; msgId++) {
    const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
      chat_id: chatId,
      from_chat_id: env.STORAGE_CHANNEL_ID,
      message_id: msgId,
    });
    results.push(res);
  }
  return results;
}

// Telegram API Call Helper
async function callTelegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
