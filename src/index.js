/**
 * PixelPop Telegram File Store Bot (Cloudflare Worker)
 * Production Ready - Pro Version with Force Sub, Auto Delete (6h), Bilingual
 */

export default {
  // 1. Scheduled Cron Event (පැය 6න් පරණ Files Delete කිරීමට)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanExpiredMessages(env));
  },

  async fetch(request, env, ctx) {
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

    // Lazy Auto Deletion (Background cleanup on incoming requests)
    ctx.waitUntil(cleanExpiredMessages(env));

    // 🔍 System Diagnostic Test
    if (url.pathname === "/test") {
      const storageCheck = await callTelegram(env.BOT_TOKEN, "getChat", {
        chat_id: env.STORAGE_CHANNEL_ID,
      });

      const fsubCheck = env.FORCE_SUB_CHANNEL_ID
        ? await callTelegram(env.BOT_TOKEN, "getChat", { chat_id: env.FORCE_SUB_CHANNEL_ID })
        : { ok: true, note: "Force sub not configured" };

      const adminCheck = await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        text: "🔔 Test Message: System is 100% operational!",
      });

      return new Response(
        JSON.stringify(
          {
            storage_channel: storageCheck,
            main_channel_fsub: fsubCheck,
            admin_status: adminCheck,
            configured_storage_id: env.STORAGE_CHANNEL_ID,
            configured_fsub_id: env.FORCE_SUB_CHANNEL_ID,
          },
          null,
          2
        ),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. WEBSITE VERIFY ENDPOINT
    if (url.pathname === "/verify") {
      const userId = url.searchParams.get("a");
      if (!userId) {
        return new Response("Missing user ID", { status: 400, headers: corsHeaders });
      }

      const userKey = `user_${userId}`;
      const userData = await env.BOT_KV.get(userKey, { type: "json" });

      if (userData) {
        userData.verified = true;
        await env.BOT_KV.put(userKey, JSON.stringify(userData), { expirationTtl: 3600 });

        let idsToSend = userData.msgIds;
        if (!idsToSend && userData.startMsg && userData.endMsg) {
          idsToSend = [];
          for (let i = userData.startMsg; i <= userData.endMsg; i++) idsToSend.push(i);
        }

        let tgResults = [];
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

    // 3. TELEGRAM WEBHOOK HANDLER
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK");
    }

    return new Response("PixelPop Bot is Running Online!");
  },
};

// ================= TELEGRAM HANDLER =================
async function handleTelegramUpdate(update, env) {
  // A. Message Handler
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id.toString();
    const text = msg.text || "";

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
          channelMsgId = originMsgId;
          let batch = (await env.BOT_KV.get("admin_batch", { type: "json" })) || [];
          batch.push(channelMsgId);
          await env.BOT_KV.put("admin_batch", JSON.stringify(batch), { expirationTtl: 86400 });

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `✅ **Storage Channel File Detected!** (ID: \`${channelMsgId}\`)\nForward more files or send /done when finished.\n\n✅ **Storage Channel එකේ File එකක් අඳුනාගත්තා!** (ID: \`${channelMsgId}\`)\nතව Files එවන්න හෝ අවසන් වූ පසු /done යවන්න.`,
            parse_mode: "Markdown",
          });
          return;
        } else {
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
              text: `📥 **File Copied to Storage Channel!** (Saved as ID: \`${channelMsgId}\`)\nForward more or send /done.\n\n📥 **File එක Channel එකට Copy කරන ලදී!** (Saved ID: \`${channelMsgId}\`)\nතව එවන්න හෝ /done යවන්න.`,
              parse_mode: "Markdown",
            });
          } else {
            await callTelegram(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: `❌ **Failed to Copy to Channel!**\nError: \`${res.description || "Unknown"}\`\n\n❌ **File එක Channel එකට දැමීමට නොහැකි විය!**`,
              parse_mode: "Markdown",
            });
          }
          return;
        }
      }

      if (text === "/done") {
        const batch = await env.BOT_KV.get("admin_batch", { type: "json" });

        if (!batch || batch.length === 0) {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "⚠️ **No files in queue!** Please forward some files first.\n\n⚠️ **Files කිසිවක් ලැබී නොමැත!** කරුණාකර Files Forward කරන්න.",
            parse_mode: "Markdown",
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
          text: `🎉 *Batch Link Generated Successfully!*\n━━━━━━━━━━━━━━━━━━━\n📁 *Files Count:* ${uniqueIds.length}\n🔢 *Message IDs:* \`${uniqueIds.join(", ")}\`\n\n🔗 *Shareable Link:*\n\`${finalLink}\`\n━━━━━━━━━━━━━━━━━━━\n_(Tap link to copy & paste in your channel post)_`,
        });

        await env.BOT_KV.delete("admin_batch");
        return;
      }

      if (text === "/cancel") {
        await env.BOT_KV.delete("admin_batch");
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "🗑️ **Batch Cleared!** / **Batch එක සාර්ථකව ඉවත් කරන ලදී.**",
          parse_mode: "Markdown",
        });
        return;
      }
    }

    // 2. HELP COMMAND
    if (text === "/help") {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "Markdown",
        text: `📖 **How to Use this Bot / භාවිතා කරන්නේ කෙසේද?**\n\n**English:**\n1. Click on any Movie/Series link from our channel.\n2. Make sure you are subscribed to our main channel.\n3. Watch the quick 5-second ad to unlock files.\n4. Files will be delivered directly here! Save or forward them within 6 hours.\n\n**සිංහල:**\n1. අපගේ Channel එකේ ඇති Movie/Series link එකක් ඔබන්න.\n2. අපගේ ප්‍රධාන Channel එකට Join වී සිටින්න.\n3. තත්පර 5ක Ad එක නරඹා Files ලබාගන්න.\n4. ලැබෙන Files පැය 6කින් මැකී යන බැවින් Saved Messages වෙත දමාගන්න!`,
      });
      return;
    }

    // 3. /start COMMAND (Deep Link Handler)
    if (text.startsWith("/start")) {
      const parts = text.split(" ");

      if (parts.length > 1) {
        const payload = parts[1];

        // 🛡️ CHECK FORCE SUBSCRIBE FIRST
        const isSubscribed = await checkUserSubscription(env, chatId);
        if (!isSubscribed) {
          // Save pending payload to retry after joining
          await env.BOT_KV.put(`pending_fsub_${chatId}`, payload, { expirationTtl: 3600 });

          const fsubKeyboard = {
            inline_keyboard: [
              [{ text: `📢 Join ${env.FORCE_SUB_CHANNEL_NAME || "Our Channel"}`, url: env.FORCE_SUB_CHANNEL_LINK }],
              [{ text: "🔄 Try Again / නැවත උත්සාහ කරන්න", callback_data: `check_fsub_${payload}` }],
            ],
          };

          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            parse_mode: "Markdown",
            text: `⚠️ **Access Denied! Join Required**\nYou must join our official channel to download files.\n\n⚠️ **ප්‍රවේශය ප්‍රතික්ෂේප විය!**\nFiles ලබා ගැනීමට නම් ඔබ අපගේ ප්‍රධාන Channel එකට සම්බන්ධ විය යුතුය. පහත Button එකෙන් Join වී **Try Again** ඔබන්න!`,
            reply_markup: fsubKeyboard,
          });
          return;
        }

        // Proceed to generate ad link
        await initiateFileSession(env, chatId, payload);
      } else {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "Markdown",
          text: `👋 **Welcome to PixelPop File Store!**\nPlease use download links from our movie channel to access files.\n\n👋 **PixelPop File Store වෙත සාදරයෙන් පිළිගනිමු!**\nFiles ලබා ගැනීමට කරුණාකර අපගේ Channel එකේ ඇති Download Links භාවිතා කරන්න.`,
        });
      }
    }
  }

  // B. Callback Handler
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.from.id.toString();

    // 1. Force Sub "Try Again" Button
    if (cb.data.startsWith("check_fsub_")) {
      const payload = cb.data.replace("check_fsub_", "");
      const isSubscribed = await checkUserSubscription(env, chatId);

      if (isSubscribed) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Membership Verified! / ඔබ සාර්ථකව සම්බන්ධ වී ඇත!",
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

    // 2. "I have clicked ads" Button
    if (cb.data === "check_ad") {
      const userKey = `user_${chatId}`;
      const data = await env.BOT_KV.get(userKey, { type: "json" });

      if (!data) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ Session Expired! Please click the download link again.\nSession එක කල් ඉකුත් වී ඇත.",
          show_alert: true,
        });
        return;
      }

      if (data.delivered === true) {
        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Files already sent! Check your chat.\nFiles දැනටමත් ඔබ වෙත එවා ඇත!",
          show_alert: false,
        });
        return;
      }

      if (data.verified === true) {
        data.delivered = true;
        await env.BOT_KV.put(userKey, JSON.stringify(data), { expirationTtl: 3600 });

        await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Verified! Sending files now...\nතහවුරු විය! Files එවමින් පවතී...",
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
          text: "❌ You haven't watched the ad yet! Please watch the 5s ad.\nඔබ තවමත් Ad එක නරඹා නැත!",
          show_alert: true,
        });
      }
    }
  }
}

// ================= HELPER FUNCTIONS =================

// User FSUB Membership Verification
async function checkUserSubscription(env, userId) {
  if (!env.FORCE_SUB_CHANNEL_ID) return true; // Disabled if not set
  if (userId.toString() === env.ADMIN_ID?.toString()) return true; // Admin bypass

  try {
    const res = await callTelegram(env.BOT_TOKEN, "getChatMember", {
      chat_id: env.FORCE_SUB_CHANNEL_ID,
      user_id: userId,
    });

    if (!res.ok) return true; // Fail safe if permission issue

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
        [{ text: "🎬 Watch Ads (for 5s) / Ad එක නරඹන්න", url: adUrl }],
        [{ text: "I have clicked ads ⁉️ / Ad එක බැලුවා", callback_data: "check_ad" }],
      ],
    };

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "Markdown",
      text: `👇 **Watch a Quick 5-Second Ad to Get Files:**\nClick the button below, watch the ad, and return here. Files will be delivered automatically.\n\n👇 **Files ලබා ගැනීමට තත්පර 5ක Ad එක නරඹන්න:**\nපහත Button එක ඔබා Ad එක නරඹන්න. Files ස්වයංක්‍රීයව ලැබෙනු ඇත.`,
      reply_markup: keyboard,
    });
  } catch {
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ Invalid Link! Please try again from the channel.\nවලංගු නොවන Link එකකි.",
    });
  }
}

// Send Files & Schedule 6-Hour Auto Deletion
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

  // ⏳ Send Bilingual 6-Hour Warning Notice
  const warningMsg = await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "Markdown",
    text: `⚠️ **IMPORTANT NOTICE / විශේෂ දැනුම්දීමයි:**\n━━━━━━━━━━━━━━━━━━━━\n🇬🇧 **English:**\nThese files will be **automatically deleted in 6 hours** due to copyright & storage limits.\n👉 **Please forward them to your 'Saved Messages' or download to your phone right now!**\n\n🇱🇰 **සිංහල:**\nප්‍රකාශන හිමිකම් සහ ඉඩකඩ සීමා නිසා මෙම Files **පැය 6කින් ස්වයංක්‍රීයව මැකී යනු ඇත.**\n👉 **දැන්ම ඔබගේ 'Saved Messages' වෙත Forward කරගන්න හෝ Phone එකට Save කරගන්න!**\n━━━━━━━━━━━━━━━━━━━━`,
  });

  if (warningMsg.ok) {
    sentMessageIds.push(warningMsg.result.message_id);
  }

  // 6 Hours Deletion Timestamp (Current Time + 6 hours)
  const deleteAt = Date.now() + 6 * 60 * 60 * 1000;

  // Save to Deletion Queue in KV
  let queue = (await env.BOT_KV.get("deletion_queue", { type: "json" })) || [];
  for (const sentId of sentMessageIds) {
    queue.push({ chatId, messageId: sentId, deleteAt });
  }
  await env.BOT_KV.put("deletion_queue", JSON.stringify(queue));

  return results;
}

// Cleanup Expired Messages (Runs on scheduled event & lazily)
async function cleanExpiredMessages(env) {
  const queue = await env.BOT_KV.get("deletion_queue", { type: "json" });
  if (!queue || queue.length === 0) return;

  const now = Date.now();
  const remaining = [];

  for (const item of queue) {
    if (item.deleteAt <= now) {
      // Time is up! Delete from user chat
      await callTelegram(env.BOT_TOKEN, "deleteMessage", {
        chat_id: item.chatId,
        message_id: item.messageId,
      });
    } else {
      remaining.push(item);
    }
  }

  if (remaining.length !== queue.length) {
    await env.BOT_KV.put("deletion_queue", JSON.stringify(remaining));
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
