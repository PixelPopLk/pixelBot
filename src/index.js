/**
 * PixelPop Telegram File Store Bot (Cloudflare Worker + D1 Database)
 * Features:
 * - Scalable, serverless Cloudflare Worker architecture
 * - Multi-tier Monetization: Telegram Stars (60 Stars), Local BOC Bank (LKR 350), Rewarded Ads
 * - Auto-Expiring VIP Subscriptions (Auto removed after 30 days)
 * - Protected Content: Forwarding & saving disabled (protect_content: true)
 * - Episode-by-Episode Links (Free) + Complete Season Pack (VIP 1-Click)
 * - Self-Healing D1 Database with Automatic Schema Migrations
 * - Admin File Ingestion, Broadcast Engine & Real-Time Stats
 */

let isSchemaMigrated = false;

export default {
  // 1. Scheduled Cron Event (ක්‍රියාත්මක වන්නේ සෑම විනාඩි 10කට වරක්)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTasks(env));
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

    // Optimize D1: Only ensure schema once per worker isolate lifecycle
    if (!isSchemaMigrated) {
      await ensureSchema(env);
    }

    // 🔍 1. SYSTEM DIAGNOSTIC TEST (Protected by Admin ID or Secret)
    if (url.pathname === "/test") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.ADMIN_ID) {
        return new Response(
          JSON.stringify({ error: "Unauthorized access. Pass ?secret=" + (env.ADMIN_ID || "YOUR_ADMIN_ID") }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const botInfo = await callTelegram(env.BOT_TOKEN, "getMe", {});
      const webhookInfo = await callTelegram(env.BOT_TOKEN, "getWebhookInfo", {});
      const storageCheck = await callTelegram(env.BOT_TOKEN, "getChat", {
        chat_id: env.STORAGE_CHANNEL_ID,
      });

      const fsubCheck = env.FORCE_SUB_CHANNEL_ID
        ? await callTelegram(env.BOT_TOKEN, "getChat", { chat_id: env.FORCE_SUB_CHANNEL_ID })
        : { ok: true, note: "Force sub not configured" };

      let d1Status = "OK";
      let userCount = 0;
      try {
        const u = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
        userCount = u?.count || 0;
      } catch (err) {
        d1Status = `D1 Error: ${err.message}`;
      }

      return new Response(
        JSON.stringify(
          {
            bot_info: botInfo,
            webhook_info: webhookInfo,
            database_status: d1Status,
            total_users: userCount,
            storage_channel: storageCheck?.ok ? "Connected" : storageCheck,
            main_channel_fsub: fsubCheck?.ok ? "Connected" : fsubCheck,
          },
          null,
          2
        ),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. AD CLICK & VERIFICATION RECORD (Secret Token-based Anti-Bypass System)
    if (url.pathname === "/verify" || url.pathname === "/verify_ad" || url.pathname === "/ad_started") {
      const userId = url.searchParams.get("u") || url.searchParams.get("a");
      const token = url.searchParams.get("t");

      if (userId && env.DB) {
        if (token) {
          // Cryptographic token verification from verify.html
          const user = await env.DB.prepare(`SELECT verify_token FROM users WHERE user_id = ?`).bind(userId.toString()).first();
          if (user && user.verify_token === token) {
            await env.DB.prepare(`
              UPDATE users SET ad_verified = 1, ad_started_at = ? WHERE user_id = ?
            `).bind(Date.now(), userId.toString()).run();
            return new Response(JSON.stringify({ ok: true, status: "verified" }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } else {
            return new Response(JSON.stringify({ ok: false, error: "Invalid or expired verification token" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } else {
          // Fallback legacy ad_started without token
          await env.DB.prepare(`
            UPDATE users SET ad_started_at = ? WHERE user_id = ?
          `).bind(Date.now(), userId.toString()).run();
          return new Response(JSON.stringify({ ok: true, note: "legacy_ping_received" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      return new Response("OK", { headers: corsHeaders });
    }

    // 3. TELEGRAM WEBHOOK
    if (request.method === "POST") {
      // Optional Secret Token verification
      if (env.BOT_SECRET_TOKEN) {
        const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (headerSecret !== env.BOT_SECRET_TOKEN) {
          return new Response("Unauthorized", { status: 403 });
        }
      }

      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK");
    }

    return new Response("PixelPop Telegram Bot is Running Online!");
  },
};

// ================= TELEGRAM UPDATE DISPATCHER =================
async function handleTelegramUpdate(update, env) {
  // 1. Payment Pre-Checkout Query (Telegram Stars validation)
  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query, env);
    return;
  }

  // 2. Inline Callback Queries
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  // 3. Normal Message Updates
  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }
}

// ================= MESSAGE HANDLER =================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id.toString();
  const text = (msg.text || msg.caption || "").trim();
  const user = msg.from;

  // Track / register user in D1 safely
  try {
    await ensureUserExists(env, user);
  } catch (err) {
    console.error("ensureUserExists error:", err);
  }

  // ⭐️ 1. Successful Telegram Stars Payment Receipt
  if (msg.successful_payment) {
    await handleSuccessfulPayment(msg, env);
    return;
  }

  const isAdmin = chatId === env.ADMIN_ID?.toString();

  // 👑 2. ADMIN-ONLY COMMANDS & FILE INGESTION
  if (isAdmin) {
    // A. Admin File Uploads (Videos, Documents, Photos, Audios, Forwards)
    const hasMedia = msg.video || msg.document || msg.audio || msg.animation || msg.forward_origin || msg.forward_from_chat;
    if (hasMedia) {
      await handleAdminFileUpload(msg, env);
      return;
    }

    // B. Admin Commands
    if (text.startsWith("/add ")) {
      const customTitle = text.replace("/add ", "").trim();
      try {
        await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
      } catch {
        await env.DB.prepare(`DELETE FROM admin_batch`).run();
      }
      await env.DB.prepare(`
        INSERT INTO users (user_id, msg_ids) VALUES ('admin_title_draft', ?)
        ON CONFLICT(user_id) DO UPDATE SET msg_ids = excluded.msg_ids
      `).bind(customTitle).run();
      await sendReply(
        env,
        chatId,
        `🎬 <b>Ready to Add:</b> <i>${escapeHtml(customTitle)}</i>\n━━━━━━━━━━━━━━━━━━━━\nForward all episodes or movie files now. When finished, send /done or click Generate Links.`
      );
      return;
    }

    if (text.startsWith("/done")) {
      await generateBatchLink(env, chatId);
      return;
    }

    if (text.startsWith("/cancel")) {
      try {
        await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
      } catch {
        await env.DB.prepare(`DELETE FROM admin_batch`).run();
      }
      await sendReply(env, chatId, "🗑️ <b>Batch Cleared!</b> / <b>Batch එක ඉවත් කරන ලදී.</b>");
      return;
    }

    if (text.startsWith("/title ")) {
      const customTitle = text.replace("/title ", "").trim();
      await env.DB.prepare(`
        INSERT INTO users (user_id, msg_ids) VALUES ('admin_title_draft', ?)
        ON CONFLICT(user_id) DO UPDATE SET msg_ids = excluded.msg_ids
      `).bind(customTitle).run();
      await sendReply(env, chatId, `🏷️ <b>Batch Title Set:</b> <i>${escapeHtml(customTitle)}</i>\nNow forward your files or click Generate Links.`);
      return;
    }

    if (text.startsWith("/stats")) {
      await handleAdminStats(env, chatId);
      return;
    }

    if (text.startsWith("/broadcast ")) {
      const broadcastMsg = text.replace("/broadcast ", "").trim();
      await handleBroadcast(env, chatId, broadcastMsg);
      return;
    }
  }

  // 📸 3. Non-Admin Photo Upload (Bank Slip for VIP verification)
  if (msg.photo && msg.photo.length > 0) {
    await handleSlipUpload(msg, env);
    return;
  }

  // 🌐 4. GENERAL USER COMMANDS

  // A. Language Switch
  if (text.startsWith("/language") || text.startsWith("/lang")) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: "🇱🇰 සිංහල", callback_data: "set_lang_si" },
          { text: "🇬🇧 English", callback_data: "set_lang_en" },
        ],
      ],
    };
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "🌐 <b>Select your preferred language / භාෂාව තෝරන්න:</b>",
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }

  // B. VIP Membership Command
  if (text.startsWith("/vip")) {
    await sendVipInfoCard(env, chatId);
    return;
  }

  // C. Referral & Invite Command
  if (text.startsWith("/referral") || text.startsWith("/invite")) {
    await sendReferralCard(env, chatId);
    return;
  }

  // D. Help Command
  if (text.startsWith("/help")) {
    const backupBot = env.BACKUP_BOT_USERNAME || "PixelPopStorebot";
    const lang = await getUserLang(env, chatId);
    const helpMsg = lang === "si"
      ? `📖 <b>PixelPop Bot භාවිතා කරන්නේ කෙසේද?</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ <b>Live Search:</b> ඕනෑම චිත්‍රපටයක නම මෙහි Type කරන්න (උදා: Avatar, Inception).\n2️⃣ <b>Download Links:</b> Channel එකේ ඇති Download Links මගින්ද ලබාගත හැක.\n3️⃣ <b>නොමිලේ ලබා ගැනීමට:</b> '🎬 Watch Ad' ඔබා තත්පර 5ක් නරඹා 'I have watched ad ⁉️' ඔබන්න.\n4️⃣ <b>Instant Download:</b> Ads නැතිව ⭐️ 5 Stars මගින් ක්ෂණිකව ලබාගත හැක.\n\n🎬 <b>චිත්‍රපට ඉල්ලීමට:</b> /request Movie Name\n👑 <b>VIP සාමාජිකත්වය:</b> /vip\n🛡️ <b>Backup Bot:</b> /backup`
      : `📖 <b>How to Use PixelPop Bot:</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ <b>Live Search:</b> Just type any movie/series name here (e.g., Inception, Avatar).\n2️⃣ <b>Download Links:</b> Tap links posted in our official channel.\n3️⃣ <b>Free Access:</b> Tap '🎬 Watch Ad', wait 5s, and verify.\n4️⃣ <b>Instant Access:</b> Skip ads instantly with ⭐️ 5 Stars!\n\n🎬 <b>Request Movies:</b> /request Movie Name\n👑 <b>VIP Membership:</b> /vip\n🛡️ <b>Backup Bot:</b> /backup`;

    await sendReply(env, chatId, helpMsg);
    return;
  }

  // E. /backup Command
  if (text.startsWith("/backup")) {
    const backupBot = env.BACKUP_BOT_USERNAME || "PixelPopStorebot";
    const backupLink = env.BACKUP_CHANNEL_LINK || env.FORCE_SUB_CHANNEL_LINK || "https://t.me/pixel_pop_lk";
    const backupMsg = `🛡️ <b>PixelPop Official Backup System:</b>\n━━━━━━━━━━━━━━━━━━━━\nප්‍රධාන Bot ට යම් කාර්මික දෝෂයක් හෝ Telegram සීමාවක් ආවොත්, සේවාව අඛණ්ඩව ලබා ගැනීමට Backup Bot හා Channel එක save කර තබාගන්න!\n\n🤖 <b>Backup Bot:</b> @${backupBot}\n🔗 <b>Direct Link:</b> https://t.me/${backupBot}\n📢 <b>Backup Channel:</b> ${backupLink}\n━━━━━━━━━━━━━━━━━━━━\n<i>දෙකෙහිම එකම Movies & Series Database එක ක්‍රියාත්මක වේ.</i>`;
    await sendReply(env, chatId, backupMsg);
    return;
  }

  // F. /request Command (Movie & Series Requests)
  if (text.startsWith("/request") || text.startsWith("/req")) {
    const query = text.replace(/^\/(request|req)\s*/i, "").trim();
    if (!query) {
      await sendReply(
        env,
        chatId,
        `🎬 <b>PixelPop Request Desk:</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබට අවශ්‍ය ඕනෑම Movie හෝ TV Series එකක් අපෙන් ඉල්ලීමට:\n<code>/request Movie Name</code> ලෙස Type කර එවන්න.\n\nඋදාහරණ: <code>/request Spider-Man No Way Home</code>`
      );
      return;
    }
    const userName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || "User");
    await handleMovieRequest(env, chatId, userName, query);
    return;
  }

  // G. /search Command (Explicit Search)
  if (text.startsWith("/search ")) {
    const query = text.replace("/search ", "").trim();
    await handleLiveSearch(env, chatId, query);
    return;
  }

  // H. /start Command (Deep Link & Referral handling)
  if (text.startsWith("/start")) {
    const parts = text.split(" ");

    if (parts.length > 1) {
      const payload = parts[1].trim();

      // Check if it's a referral link: ref_123456789
      if (payload.startsWith("ref_")) {
        const referrerId = payload.replace("ref_", "");
        await handleReferralStart(env, chatId, referrerId);
        return;
      }

      // Check Force Subscription before file access
      const isSubscribed = await checkUserSubscription(env, chatId);
      if (!isSubscribed) {
        await sendForceSubMessage(env, chatId, payload);
        return;
      }

      // Valid subscriber -> Initiate File Preview / Session
      await initiateFileSession(env, chatId, payload);
    } else {
      const backupBot = env.BACKUP_BOT_USERNAME || "PixelPopStorebot";
      const lang = await getUserLang(env, chatId);
      const welcomeText = lang === "si"
        ? `👋 <b>PixelPop File Store වෙත සාදරයෙන් පිළිගනිමු!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔍 <b>Live Search:</b> ඕනෑම චිත්‍රපටයක නම මෙහි Type කර Poster එක හා Links ලබාගන්න!\n\n👑 <b>VIP සාමාජිකත්වය:</b> /vip\n🎬 <b>චිත්‍රපට ඉල්ලීමට:</b> /request\n👥 <b>නොමිලේ VIP ලබාගන්න:</b> /referral\n🛡️ <b>Backup Bot:</b> @${backupBot}\n🌐 <b>භාෂාව වෙනස් කිරීමට:</b> /language`
        : `👋 <b>Welcome to PixelPop File Store!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔍 <b>Live Search:</b> Simply type any Movie / Series name here to search!\n\n👑 <b>VIP Membership:</b> /vip\n🎬 <b>Request Movies:</b> /request\n👥 <b>Free VIP Pass:</b> /referral\n🛡️ <b>Backup Bot:</b> @${backupBot}\n🌐 <b>Language:</b> /language`;

      await sendReply(env, chatId, welcomeText);
    }
    return;
  }

  // 🔍 5. IN-BOT LIVE SEARCH (PLAIN TEXT - NO COMMAND NEEDED)
  if (!text.startsWith("/") && text.length >= 2) {
    await handleLiveSearch(env, chatId, text);
    return;
  }
}

// ================= ADMIN FILE INGESTION =================
async function handleAdminFileUpload(msg, env) {
  const chatId = msg.chat.id.toString();
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
  } else {
    // Copy to storage channel
    const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
      chat_id: env.STORAGE_CHANNEL_ID,
      from_chat_id: chatId,
      message_id: msg.message_id,
    });

    if (res.ok) {
      channelMsgId = res.result.message_id;
    } else {
      await sendReply(
        env,
        chatId,
        `❌ <b>Error copying to Storage Channel:</b> ${res.description || "Unknown"}\n\n⚠️ කරුණාකර Bot ඔබේ Storage Channel (<code>${env.STORAGE_CHANNEL_ID}</code>) එකේ <b>Administrator</b> කෙනෙක් කර 'Post Messages' permission ලබා දී ඇතිදැයි බලන්න!`
      );
      return;
    }
  }

  // Insert into admin batch queue (fail-safe)
  try {
    await env.DB.prepare(`
      INSERT INTO admin_batch (admin_id, message_id) VALUES (?, ?)
    `).bind(chatId, channelMsgId).run();
  } catch (e) {
    await env.DB.prepare(`
      INSERT INTO admin_batch (message_id) VALUES (?)
    `).bind(channelMsgId).run();
  }

  let count = 1;
  try {
    const countRes = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM admin_batch WHERE admin_id = ?
    `).bind(chatId).first();
    count = countRes?.count || 1;
  } catch {
    const countRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM admin_batch`).first();
    count = countRes?.count || 1;
  }

  const adminKb = {
    inline_keyboard: [
      [{ text: "🔗 Generate Links Now / Links සාදන්න", callback_data: "admin_done" }],
      [{ text: "🗑️ Cancel Batch / අවලංගු කරන්න", callback_data: "admin_cancel" }],
    ],
  };

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `📥 <b>File Saved to Storage Channel!</b> (ID: <code>${channelMsgId}</code>)\nTotal files in batch: <b>${count}</b>\n\nForward more files, or click below to generate links:`,
    reply_markup: adminKb,
  });
}

// ================= CALLBACK QUERY HANDLER =================
async function handleCallbackQuery(cb, env) {
  const chatId = cb.from.id.toString();
  const data = cb.data || "";

  // 1. Language Toggle
  if (data === "set_lang_si" || data === "set_lang_en") {
    const newLang = data === "set_lang_si" ? "si" : "en";
    try {
      await env.DB.prepare(`UPDATE users SET language = ? WHERE user_id = ?`).bind(newLang, chatId).run();
    } catch (e) {
      console.error("Language update error:", e);
    }
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: newLang === "si" ? "✅ භාෂාව සිංහල ලෙස සකසන ලදී!" : "✅ Language set to English!",
    });
    await sendReply(
      env,
      chatId,
      newLang === "si" ? "✅ භාෂාව සාර්ථකව යාවත්කාලීන විය!" : "✅ Language successfully updated!"
    );
    return;
  }

  // 2. Admin Done / Cancel
  if (data === "admin_done" && chatId === env.ADMIN_ID?.toString()) {
    await generateBatchLink(env, chatId);
    return;
  }

  if (data === "admin_cancel" && chatId === env.ADMIN_ID?.toString()) {
    try {
      await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
    } catch {
      await env.DB.prepare(`DELETE FROM admin_batch`).run();
    }
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "🗑️ Batch Cleared!",
    });
    await sendReply(env, chatId, "🗑️ Batch එක ඉවත් කරන ලදී.");
    return;
  }

  // 3. Force Sub "Try Again"
  if (data.startsWith("check_fsub_")) {
    const payload = data.replace("check_fsub_", "");
    const isSubscribed = await checkUserSubscription(env, chatId);

    if (isSubscribed) {
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "✅ Membership Verified!",
        show_alert: false,
      });

      // Award referral credit if this user was referred
      await grantReferralIfPending(env, chatId);

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

  // 4. Fast Pass Purchase via Stars (5 Stars)
  if (data.startsWith("buy_fast_pass_")) {
    const batchToken = data.replace("buy_fast_pass_", "");
    await sendStarsInvoice(env, chatId, {
      title: "⚡ Fast Pass Download",
      description: "Instant download without watching any ads!",
      payload: `fast_pass_${batchToken}`,
      starsAmount: 5,
    });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  // 5. VIP Stars Menu & Purchases
  if (data === "vip_stars_menu") {
    const starsKb = {
      inline_keyboard: [
        [{ text: "🗓️ Weekly Pass - ⭐️ 20 Stars (7 Days)", callback_data: "buy_vip_stars_weekly" }],
        [{ text: "🗓️ Monthly Pass - ⭐️ 60 Stars (30 Days)", callback_data: "buy_vip_stars_30d" }],
        [{ text: "👑 Lifetime VIP - ⭐️ 500 Stars (Forever)", callback_data: "buy_vip_stars_lifetime" }],
        [{ text: "🔙 Back / ආපසු", callback_data: "vip_back" }],
      ],
    };
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "⭐️ <b>Telegram Stars VIP Packages:</b>\n━━━━━━━━━━━━━━━━━━━━\nTelegram Stars මගින් ගෙවූ සැනින් VIP සක්‍රීය වේ (Automatic Instant Activation):\n\n• 🗓️ <b>Weekly:</b> ⭐️ 20 Stars (දින 7)\n• 🗓️ <b>Monthly:</b> ⭐️ 60 Stars (දින 30)\n• 👑 <b>Lifetime:</b> ⭐️ 500 Stars (සදාකාලික)\n━━━━━━━━━━━━━━━━━━━━",
      reply_markup: starsKb,
    });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "vip_back") {
    await sendVipInfoCard(env, chatId);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "buy_vip_stars_weekly") {
    await sendStarsInvoice(env, chatId, {
      title: "🗓️ Weekly VIP Pass (7 Days)",
      description: "Ad-free unlimited downloads + permanent files for 7 days!",
      payload: "vip_stars_7d",
      starsAmount: 20,
    });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "buy_vip_stars_30d") {
    await sendStarsInvoice(env, chatId, {
      title: "👑 30-Day VIP Pass",
      description: "Unlimited ad-free downloads + permanent files for 30 days!",
      payload: "vip_30d",
      starsAmount: 60,
    });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "buy_vip_stars_lifetime") {
    await sendStarsInvoice(env, chatId, {
      title: "👑 Lifetime VIP Pass",
      description: "Permanent ad-free access with zero auto-deletion forever!",
      payload: "vip_stars_lifetime",
      starsAmount: 500,
    });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  // 6. VIP BOC Bank Plan Selections
  if (data === "vip_plan_weekly") {
    await sendBankPaymentInstructions(env, chatId, "weekly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "vip_plan_monthly") {
    await sendBankPaymentInstructions(env, chatId, "monthly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "vip_plan_lifetime") {
    await sendBankPaymentInstructions(env, chatId, "lifetime");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "vip_pay_bank") {
    await sendBankPaymentInstructions(env, chatId, "all");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  // 7. Admin VIP Approval / Rejection
  if (data.startsWith("vip_approve_weekly_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_approve_weekly_", "");
    await handleAdminVipApproval(env, chatId, reqId, "weekly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Weekly VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_approve_monthly_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_approve_monthly_", "");
    await handleAdminVipApproval(env, chatId, reqId, "monthly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Monthly VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_approve_lifetime_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_approve_lifetime_", "");
    await handleAdminVipApproval(env, chatId, reqId, "lifetime");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "👑 Lifetime VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_approve_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_approve_", "");
    await handleAdminVipApproval(env, chatId, reqId, "monthly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_reject_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_reject_", "");
    await handleAdminVipApproval(env, chatId, reqId, "reject");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "❌ VIP Rejected." });
    return;
  }

  // 8. Movie Request Admin Actions & User Button Request
  if (data.startsWith("req_fulfill_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("req_fulfill_", "");
    const req = await env.DB.prepare(`SELECT * FROM requests WHERE id = ?`).bind(reqId).first();
    if (req) {
      await env.DB.prepare(`UPDATE requests SET status = 'fulfilled' WHERE id = ?`).bind(reqId).run();
      await sendReply(
        env,
        req.user_id,
        `🎉 <b>Good News! ඔබ ඉල්ලූ Movie/Series එක දැන් Ready!</b>\n━━━━━━━━━━━━━━━━━━━━\n🎬 <b>${escapeHtml(req.query)}</b> දැන් PixelPop වෙත එක් කර ඇත!\nදැන්ම නම Search කර හෝ අපගේ Channel එකෙන් ලබාගන්න.`
      );
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ User notified!" });
      await sendReply(env, chatId, `✅ Marked Request #${reqId} (${req.query}) as Fulfilled & User Notified.`);
    }
    return;
  }

  if (data.startsWith("req_decline_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("req_decline_", "");
    await env.DB.prepare(`UPDATE requests SET status = 'rejected' WHERE id = ?`).bind(reqId).run();
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Request declined." });
    await sendReply(env, chatId, `❌ Request #${reqId} declined.`);
    return;
  }

  if (data.startsWith("req_movie_")) {
    const movieTitle = data.replace("req_movie_", "");
    const userName = cb.from.username ? `@${cb.from.username}` : (cb.from.first_name || "User");
    await handleMovieRequest(env, chatId, userName, movieTitle);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "✅ Request submitted to Admin!",
    });
    return;
  }

  // 8. "I have clicked ads" Button Verification
  if (data === "check_ad") {
    await handleAdVerification(env, chatId, cb);
    return;
  }

  // 9. Cooldown Refresh Button
  if (data.startsWith("refresh_cooldown_")) {
    const payload = data.replace("refresh_cooldown_", "");
    const user = await env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(chatId).first();
    const COOLDOWN_MS = 5 * 60 * 1000;
    const lastDownload = user?.last_download_at || 0;
    const timePassed = Date.now() - lastDownload;

    if (lastDownload > 0 && timePassed < COOLDOWN_MS && !isUserVipActive(user)) {
      const remainingMs = COOLDOWN_MS - timePassed;
      const remainingMins = Math.floor(remainingMs / 60000);
      const remainingSecs = Math.ceil((remainingMs % 60000) / 1000);
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: `⏳ Cooldown active: ${remainingMins}m ${remainingSecs}s remaining!`,
        show_alert: true,
      });
    } else {
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "✅ Cooldown finished! Ready to download.",
        show_alert: false,
      });
      await initiateFileSession(env, chatId, payload);
    }
    return;
  }
}

// ================= AD VERIFICATION & FILE DISPATCH =================
async function handleAdVerification(env, chatId, cb) {
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

  // 1. Check if ad was verified with secret token or opened
  if (user.ad_verified !== 1 && !user.ad_started_at) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "❌ You haven't completed the sponsor ad on the website yet!\nඔබ තවමත් Sponsor Ad එක සම්පූර්ණ කර නැත!",
      show_alert: true,
    });
    return;
  }

  // 2. 5-second anti-cheat verification
  const startTime = user.ad_started_at || 0;
  const timePassedSeconds = (Date.now() - startTime) / 1000;
  if (timePassedSeconds < 5) {
    const remaining = Math.ceil(5 - timePassedSeconds);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: `⏳ Please watch the ad for 5 seconds! (${remaining}s remaining)\nකරුණාකර තවත් තත්පර ${remaining}ක් Ad එක නරඹා නැවත උත්සාහ කරන්න.`,
      show_alert: true,
    });
    return;
  }

  // Mark as delivered
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

  // Check if user is VIP (VIP files are never auto-deleted)
  const isVip = isUserVipActive(user);
  await sendBatchFiles(env, chatId, idsToSend, isVip);
}

// ================= SESSION & PREVIEW CARDS =================
async function initiateFileSession(env, chatId, payload) {
  try {
    let targetMsgIds = [];
    let movieTitle = null;
    let posterUrl = null;

    // A. Check modern secure UUID batch token (b_xxxxxxxx)
    if (payload.startsWith("b_")) {
      const batch = await env.DB.prepare(`
        SELECT * FROM batches WHERE token = ?
      `).bind(payload).first();

      if (!batch) {
        throw new Error("Batch not found");
      }
      targetMsgIds = JSON.parse(batch.msg_ids);
      movieTitle = batch.title;
      posterUrl = batch.poster_url || null;
    } else {
      // B. Backward compatibility for legacy Base64 links
      const rawCode = atob(payload);
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
    }

    // Save target session in D1 + generate fresh secret verification token
    const verifyToken = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

    await env.DB.prepare(`
      INSERT INTO users (user_id, msg_ids, ad_started_at, delivered, ad_verified, verify_token)
      VALUES (?, ?, NULL, 0, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        msg_ids = excluded.msg_ids,
        ad_started_at = NULL,
        delivered = 0,
        ad_verified = 0,
        verify_token = excluded.verify_token
    `).bind(chatId, JSON.stringify(targetMsgIds), verifyToken).run();

    // Check if user has active VIP (no cooldown, no ads)
    const user = await env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(chatId).first();
    if (isUserVipActive(user)) {
      await sendReply(
        env,
        chatId,
        `👑 <b>VIP Member Detected!</b>\nBypassing all ads. Delivering your files immediately without expiry limit...`
      );
      await sendBatchFiles(env, chatId, targetMsgIds, true);
      return;
    }

    // 🕐 COOLDOWN CHECK for Free Users (5 minutes between downloads)
    const COOLDOWN_MS = 5 * 60 * 1000;
    const lastDownload = user?.last_download_at || 0;
    const timePassed = Date.now() - lastDownload;

    if (lastDownload > 0 && timePassed < COOLDOWN_MS) {
      const remainingMs = COOLDOWN_MS - timePassed;
      const remainingMins = Math.floor(remainingMs / 60000);
      const remainingSecs = Math.ceil((remainingMs % 60000) / 1000);

      const cooldownKeyboard = {
        inline_keyboard: [
          [{ text: `⏳ Wait ${remainingMins}m ${remainingSecs}s (Free Limit)`, callback_data: `refresh_cooldown_${payload}` }],
          [{ text: "⚡ Skip Cooldown with 5 Stars (Instant)", callback_data: `buy_fast_pass_${payload}` }],
          [{ text: "👑 Get VIP (No Limits, Forever)", callback_data: "vip_pay_bank" }],
        ],
      };

      const titleDisplay = movieTitle ? `🎬 <b>${escapeHtml(movieTitle)}</b>\n` : "";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `⏳ <b>Free Download Cooldown Active!</b>\n━━━━━━━━━━━━━━━━━━━━\n${titleDisplay}ඔබ මීට සුළු මොහොතකට පෙර Download එකක් ලබාගත්තා.\n\n⏰ <b>Cooldown:</b> තවත් <b>${remainingMins} minutes ${remainingSecs} seconds</b> රැඳී සිටින්න.\n\n💡 <b>ඉක්මනින් ගන්නද?</b>\n⚡ ⭐️ 5 Stars ගෙවා Cooldown Skip කරන්න.\n👑 VIP ලබාගෙන Unlimited Downloads!\n━━━━━━━━━━━━━━━━━━━━`,
        reply_markup: cooldownKeyboard,
      });
      return;
    }

    // Display Rich Preview & Choice Card with Secret Token embedded in verify URL
    const websiteUrl = env.WEBSITE_URL || "https://pixelpoplk.pages.dev";
    const adUrl = `${websiteUrl}/verify.html?u=${chatId}&t=${verifyToken}`;

    const titleDisplay = movieTitle ? `🎬 <b>${escapeHtml(movieTitle)}</b>\n` : "";
    const fileCount = targetMsgIds.length;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🎬 Watch Ad (Free / නොමිලේ)", url: adUrl }],
        [{ text: "✅ I have watched ad ⁉️ / බැලුවා", callback_data: "check_ad" }],
        [{ text: "⚡ Skip Ad with 5 Stars (Instant)", callback_data: `buy_fast_pass_${payload}` }],
        [{ text: "👑 Get VIP (Weekly / Monthly / Lifetime)", callback_data: "vip_pay_bank" }],
      ],
    };

    const previewMsg = `🍿 <b>PixelPop File Ready for Download:</b>\n━━━━━━━━━━━━━━━━━━━━\n${titleDisplay}📁 <b>Total Files:</b> ${fileCount} File(s)\n⚡ <b>Instant Access:</b> Pay 5 Stars to download without ads.\n🆓 <b>Free Access:</b> Click 'Watch Ad', stay 5s, and tap 'I have watched ad'.\n━━━━━━━━━━━━━━━━━━━━`;

    let sentPhoto = false;
    if (posterUrl && previewMsg.length <= 950) {
      const pRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: posterUrl,
        caption: previewMsg,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      sentPhoto = pRes.ok;
    }

    if (!sentPhoto) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: previewMsg,
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    await sendReply(env, chatId, "❌ <b>Invalid or Expired Link!</b>\nකරුණාකර Channel එකේ ඇති අලුත්ම Download Link එක භාවිතා කරන්න.");
  }
}

// ================= FILE DELIVERY & DELETION QUEUE =================
async function sendBatchFiles(env, chatId, msgIds, isVip = false) {
  let results = [];
  if (!msgIds || msgIds.length === 0) return results;

  let sentMessageIds = [];

  for (const msgId of msgIds) {
    const res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
      chat_id: chatId,
      from_chat_id: env.STORAGE_CHANNEL_ID,
      message_id: msgId,
      protect_content: true, // 🛡️ Prevent forwarding and saving
    });

    if (res.ok) {
      sentMessageIds.push(res.result.message_id);
    }
    results.push(res);
  }

  if (isVip) {
    // VIP files are permanent
    await sendReply(
      env,
      chatId,
      `👑 <b>VIP Download Complete!</b>\n━━━━━━━━━━━━━━━━━━━━\nAs an active VIP member, these files will <b>NEVER be deleted</b> from your chat. Enjoy watching!`
    );
    return results;
  }

  // Free User 6-Hour Deletion Notice
  const warningMsg = await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `⚠️ <b>IMPORTANT NOTICE / විශේෂ දැනුම්දීමයි:</b>\n━━━━━━━━━━━━━━━━━━━━\n🇬🇧 <b>English:</b>\nThese files will be <b>automatically deleted in 6 hours</b> due to copyright limits.\n👉 <b>Please forward them to your 'Saved Messages' or save to your device right now!</b>\n\n🇱🇰 <b>සිංහල:</b>\nප්‍රකාශන හිමිකම් සීමා නිසා මෙම Files <b>පැය 6කින් ස්වයංක්‍රීයව මැකී යනු ඇත.</b>\n👉 <b>දැන්ම ඔබගේ 'Saved Messages' වෙත Forward කරගන්න!</b>\n━━━━━━━━━━━━━━━━━━━━`,
  });

  if (warningMsg.ok) {
    sentMessageIds.push(warningMsg.result.message_id);
  }

  // Schedule deletion in 6 hours
  const deleteAt = Date.now() + 6 * 60 * 60 * 1000;
  for (const sentId of sentMessageIds) {
    await env.DB.prepare(`
      INSERT INTO deletions (chat_id, message_id, delete_at, reminded) VALUES (?, ?, ?, 0)
    `).bind(chatId, sentId, deleteAt).run();
  }

  // ⏱️ Record download timestamp to enforce 5-min cooldown on next request
  await env.DB.prepare(`UPDATE users SET last_download_at = ? WHERE user_id = ?`)
    .bind(Date.now(), chatId)
    .run();

  return results;
}

// ================= SCHEDULED CRON TASKS =================
async function handleScheduledTasks(env) {
  if (!env.DB) return;

  const now = Date.now();

  // 1. Auto-Expire Expired VIP Subscriptions (Monthly users)
  try {
    const expiredVips = await env.DB.prepare(`
      SELECT user_id FROM users
      WHERE is_vip = 1 AND vip_until > 0 AND vip_until <= ?
      LIMIT 50
    `).bind(now).all();

    if (expiredVips?.results && expiredVips.results.length > 0) {
      for (const u of expiredVips.results) {
        await env.DB.prepare(`
          UPDATE users SET is_vip = 0 WHERE user_id = ?
        `).bind(u.user_id).run();

        // Send friendly notification to user
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: u.user_id,
          parse_mode: "HTML",
          text: "⏰ <b>VIP Membership Expired / VIP කාලය අවසන් විය:</b>\nඔබගේ දින 30ක VIP සාමාජිකත්වය අවසන් වී ඇත. නැවත VIP ලබා ගැනීමට /vip භාවිතා කරන්න.",
        });
      }
    }
  } catch (err) {
    console.error("VIP auto-expiry error:", err);
  }

  // 2. Send 30-Minute Expiry Reminders
  try {
    const thirtyMinsFromNow = now + 30 * 60 * 1000;
    const pendingReminders = await env.DB.prepare(`
      SELECT DISTINCT chat_id FROM deletions
      WHERE delete_at <= ? AND reminded = 0
      LIMIT 20
    `).bind(thirtyMinsFromNow).all();

    if (pendingReminders?.results && pendingReminders.results.length > 0) {
      for (const r of pendingReminders.results) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: r.chat_id,
          parse_mode: "HTML",
          text: "⏰ <b>REMINDER / මතක් කිරීමක්:</b>\nඔබ බාගත කළ Files තවත් <b>විනාඩි 30කින් ස්වයංක්‍රීයව මැකී යනු ඇත!</b> කරුණාකර දැන්ම Saved Messages වෙත Forward කරගන්න.",
        });
        await env.DB.prepare(`
          UPDATE deletions SET reminded = 1 WHERE chat_id = ?
        `).bind(r.chat_id).run();
      }
    }
  } catch (err) {
    console.error("Reminder queue error:", err);
  }

  // 3. Clean Expired Messages
  try {
    const expired = await env.DB.prepare(`
      SELECT * FROM deletions WHERE delete_at <= ? LIMIT 50
    `).bind(now).all();

    if (expired?.results && expired.results.length > 0) {
      let deletedIds = [];
      for (const item of expired.results) {
        await callTelegram(env.BOT_TOKEN, "deleteMessage", {
          chat_id: item.chat_id,
          message_id: item.message_id,
        });
        deletedIds.push(item.id);
      }
      if (deletedIds.length > 0) {
        const placeholders = deletedIds.map(() => '?').join(',');
        await env.DB.prepare(`DELETE FROM deletions WHERE id IN (${placeholders})`).bind(...deletedIds).run();
      }
    }
  } catch (err) {
    console.error("Message deletion queue error:", err);
  }
}

// ================= TELEGRAM STARS (XTR) PAYMENTS =================
async function sendStarsInvoice(env, chatId, { title, description, payload, starsAmount }) {
  await callTelegram(env.BOT_TOKEN, "sendInvoice", {
    chat_id: chatId,
    title: title,
    description: description,
    payload: payload,
    currency: "XTR", // Official Telegram Stars currency
    prices: [{ label: title, amount: starsAmount }],
  });
}

async function handlePreCheckoutQuery(query, env) {
  // Always approve valid invoices
  await callTelegram(env.BOT_TOKEN, "answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok: true,
  });
}

async function handleSuccessfulPayment(msg, env) {
  const chatId = msg.chat.id.toString();
  const payment = msg.successful_payment;
  const payload = payment.invoice_payload;
  const amount = payment.total_amount;

  // Log in payments table
  await env.DB.prepare(`
    INSERT INTO payments (user_id, type, amount, currency, telegram_charge_id, created_at)
    VALUES (?, ?, ?, 'XTR', ?, ?)
  `).bind(chatId, payload, amount, payment.telegram_payment_charge_id, Date.now()).run();

  if (payload.startsWith("fast_pass_")) {
    const batchPayload = payload.replace("fast_pass_", "");
    await sendReply(
      env,
      chatId,
      "⚡ <b>Fast Pass Activated!</b>\nThank you for paying with Stars. Delivering your files immediately..."
    );
    await initiateFileSession(env, chatId, batchPayload);
  } else if (payload === "vip_stars_7d") {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + sevenDays;
    await env.DB.prepare(`UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?`).bind(expiresAt, chatId).run();
    await sendReply(
      env,
      chatId,
      `🎉 <b>Weekly VIP Pass (7 Days) Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nThank you for paying with Stars! You now have unlimited instant downloads without ads for 7 days. Your files will never be auto-deleted.`
    );
  } else if (payload === "vip_30d" || payload === "vip_stars_30d") {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + thirtyDays;
    await env.DB.prepare(`UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?`).bind(expiresAt, chatId).run();
    await sendReply(
      env,
      chatId,
      `🎉 <b>30-Day VIP Pass Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nThank you for paying with Stars! You now have unlimited instant downloads without ads, and your files will never be auto-deleted.`
    );
  } else if (payload === "vip_stars_lifetime") {
    const hundredYears = 100 * 365 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + hundredYears;
    await env.DB.prepare(`UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?`).bind(expiresAt, chatId).run();
    await sendReply(
      env,
      chatId,
      `👑 <b>LIFETIME VIP Pass Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nThank you! You now have lifetime unlimited instant downloads without ads. Your files will NEVER be auto-deleted!`
    );
  }
}

// ================= LOCAL VIP & BOC BANK SLIP SYSTEM =================
async function sendVipInfoCard(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🗓️ Weekly (Rs. 100)", callback_data: "vip_plan_weekly" },
        { text: "🗓️ Monthly (Rs. 300)", callback_data: "vip_plan_monthly" },
      ],
      [{ text: "👑 Lifetime VIP Pass (Rs. 2500)", callback_data: "vip_plan_lifetime" }],
      [{ text: "⭐️ Pay with Telegram Stars (XTR)", callback_data: "vip_stars_menu" }],
      [{ text: "🏛️ Bank of Ceylon (BOC Details)", callback_data: "vip_pay_bank" }],
    ],
  };

  const text = `👑 <b>PixelPop VIP Membership Club</b>\n━━━━━━━━━━━━━━━━━━━━\n🌟 <b>VIP විශේෂ වරප්‍රසාද:</b>\n• 🚫 <b>Zero Ads:</b> කිසිදු Sponsor Ad එකක් නැත\n• ⏳ <b>No Cooldown:</b> ලිමිට් නැතිව එක දිගට Downloads\n• 🛡️ <b>Permanent:</b> Files පැය 6කින් මැකී යන්නේ නැත\n• ⚡ <b>Complete Seasons:</b> 1-Click Instant Downloads\n\n💎 <b>පැකේජ මිල ගණන් (Flexible VIP Plans):</b>\n• 🗓️ <b>Weekly Pass (දින 7):</b> LKR 100/= (හෝ ⭐️ 20 Stars)\n• 🗓️ <b>Monthly Pass (දින 30):</b> LKR 300/= (හෝ ⭐️ 60 Stars)\n• 👑 <b>Lifetime VIP (සදාකාලික):</b> LKR 2500/= (හෝ ⭐️ 500 Stars)\n━━━━━━━━━━━━━━━━━━━━\nගෙවීම් සිදු කිරීමට පහත Button එකක් තෝරන්න:`;

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: text,
    reply_markup: keyboard,
  });
}

async function sendBankPaymentInstructions(env, chatId, plan = "all") {
  const bocAcc = env.BOC_ACCOUNT_NUMBER || "1234567890";
  const bocName = env.BOC_ACCOUNT_NAME || "R.M.P. Madusanka";

  let planDetails = "";
  if (plan === "weekly") {
    planDetails = "💎 <b>තෝරාගත් පැකේජය:</b> 🗓️ Weekly Pass (දින 7) - <b>LKR 100/=</b>\n";
  } else if (plan === "monthly") {
    planDetails = "💎 <b>තෝරාගත් පැකේජය:</b> 🗓️ Monthly Pass (දින 30) - <b>LKR 300/=</b>\n";
  } else if (plan === "lifetime") {
    planDetails = "💎 <b>තෝරාගත් පැකේජය:</b> 👑 Lifetime VIP Pass (සදාකාලික) - <b>LKR 2500/=</b>\n";
  } else {
    planDetails = "💎 <b>පැකේජ මිල ගණන්:</b>\n• 🗓️ Weekly (දින 7): <b>LKR 100/=</b>\n• 🗓️ Monthly (දින 30): <b>LKR 300/=</b>\n• 👑 Lifetime (සදාකාලික): <b>LKR 2500/=</b>\n";
  }

  const bankMsg = `🏛️ <b>Bank of Ceylon (BOC) Payment Details:</b>\n━━━━━━━━━━━━━━━━━━━━\n${planDetails}\n📋 <b>බැංකු ගිණුම් විස්තර:</b>\n• <b>Bank:</b> Bank of Ceylon (BOC)\n• <b>Account Name:</b> ${bocName}\n• <b>Account Number:</b> <code>${bocAcc}</code>\n• <b>Branch:</b> Sri Lanka\n━━━━━━━━━━━━━━━━━━━━\n📸 <b>පියවර:</b>\n1. ඉහත ගිණුමට ඔබ තෝරාගත් පැකේජයට අදාළ මුදල තැන්පත් කරන්න.\n2. ලැබෙන <b>Deposit Slip එකේ හෝ Online Banking Screenshot එකේ ඡායාරූපයක් (Photo) මෙම Bot වෙත එවන්න.</b>\n3. Admin පරීක්ෂා කර සුළු වේලාවකින් ඔබගේ VIP සක්‍රීය කරනු ඇත!`;

  await sendReply(env, chatId, bankMsg);
}

async function handleSlipUpload(msg, env) {
  const chatId = msg.chat.id.toString();
  const userName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || "User");
  const highestPhoto = msg.photo[msg.photo.length - 1];
  const fileId = highestPhoto.file_id;

  await ensureSchema(env);

  let reqId = Date.now();
  try {
    const insertRes = await env.DB.prepare(`
      INSERT INTO vip_requests (user_id, user_name, file_id, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).bind(chatId, userName, fileId, Date.now()).run();
    if (insertRes?.meta?.last_row_id) {
      reqId = insertRes.meta.last_row_id;
    }
  } catch (e) {
    console.error("vip_requests insert error:", e);
  }

  // Notify User
  await sendReply(
    env,
    chatId,
    "✅ <b>Receipt Received!</b> / ඔබගේ බැංකු රිසිට්පත ලැබුණි.\nඅපගේ Admin විසින් මෙය පරීක්ෂා කර සුළු වේලාවකින් ඔබගේ VIP සක්‍රීය කරනු ඇත."
  );

  // Forward to Admin with Multi-Tier Action Buttons
  const adminKb = {
    inline_keyboard: [
      [
        { text: "✅ Weekly (Rs. 100 / 7d)", callback_data: `vip_approve_weekly_${reqId}` },
        { text: "✅ Monthly (Rs. 300 / 30d)", callback_data: `vip_approve_monthly_${reqId}` },
      ],
      [
        { text: "👑 Lifetime (Rs. 2500)", callback_data: `vip_approve_lifetime_${reqId}` },
        { text: "❌ Reject", callback_data: `vip_reject_${reqId}` },
      ],
    ],
  };

  const adminCaption = `👑 <b>New VIP Subscription Request #${reqId}</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${userName} (<code>${chatId}</code>)\n💵 <b>Bank:</b> Bank of Ceylon (BOC)\n━━━━━━━━━━━━━━━━━━━━\n<i>Slip එකේ මුදල අනුව සුදුසු Plan එක තෝරා Approve කරන්න:</i>`;

  const sendRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", {
    chat_id: env.ADMIN_ID,
    photo: fileId,
    caption: adminCaption,
    parse_mode: "HTML",
    reply_markup: adminKb,
  });

  if (!sendRes.ok) {
    // Fallback: send text alert first so admin definitely gets notified
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      text: adminCaption,
      parse_mode: "HTML",
      reply_markup: adminKb,
    });
  }
}

async function handleAdminVipApproval(env, adminChatId, reqId, planOrDecision) {
  const req = await env.DB.prepare(`SELECT * FROM vip_requests WHERE id = ?`).bind(reqId).first();
  if (!req || req.status !== "pending") return;

  if (planOrDecision === "reject" || planOrDecision === false) {
    await env.DB.prepare(`UPDATE vip_requests SET status = 'rejected' WHERE id = ?`).bind(reqId).run();
    await sendReply(
      env,
      req.user_id,
      "❌ <b>Payment Verification Failed!</b>\nඔබ එවූ රිසිට්පත වලංගු නොවේ. කරුණාකර නිවැරදි රිසිට්පතක් සමඟ නැවත උත්සාහ කරන්න."
    );
    await sendReply(env, adminChatId, `❌ Rejected VIP for User ${req.user_id}`);
    return;
  }

  // Calculate duration based on plan
  let durationMs = 30 * 24 * 60 * 60 * 1000;
  let planName = "Monthly VIP Pass (30 Days)";

  if (planOrDecision === "weekly") {
    durationMs = 7 * 24 * 60 * 60 * 1000;
    planName = "Weekly VIP Pass (7 Days)";
  } else if (planOrDecision === "lifetime") {
    durationMs = 100 * 365 * 24 * 60 * 60 * 1000;
    planName = "LIFETIME VIP Pass (Permanent)";
  }

  const expiresAt = Date.now() + durationMs;

  await env.DB.prepare(`
    UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?
  `).bind(expiresAt, req.user_id).run();

  await env.DB.prepare(`UPDATE vip_requests SET status = 'approved' WHERE id = ?`).bind(reqId).run();

  const successMsg = planOrDecision === "lifetime"
    ? `👑 <b>LIFETIME VIP Membership Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබගේ BOC බැංකු රිසිට්පත තහවුරු විය. <b>සදාකාලික VIP සාමාජිකත්වය</b> සක්‍රීය කර ඇත!\n• කිසිදා කල් ඉකුත් නොවේ\n• 100% Zero Ads & Unlimited Downloads`
    : `🎉 <b>${planName} Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබගේ BOC බැංකු රිසිට්පත තහවුරු විය. ${planName} සාමාජිකත්වය සක්‍රීය කර ඇත. කිසිදු Ad එකක් හෝ Cooldown එකක් නැතිව Files බාගත කරගත හැක!`;

  await sendReply(env, req.user_id, successMsg);
  await sendReply(env, adminChatId, `✅ Approved ${planName} for User ${req.user_id}`);
}

// ================= VIRAL REFERRAL SYSTEM =================
async function sendReferralCard(env, chatId) {
  const user = await env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(chatId).first();
  const refCount = user?.referral_count || 0;
  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";
  const refLink = `https://t.me/${botUsername}?start=ref_${chatId}`;

  const text = `👥 <b>PixelPop Referral Program (නොමිලේ VIP ලබාගන්න!)</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබගේ යහළුවන් <b>3 දෙනෙකුට</b> අපගේ Bot Share කර නොමිලේ <b>24-Hour VIP Pass</b> එකක් ලබාගන්න!\n\n📊 <b>ඔබ දැනට Invite කර ඇති ගණන:</b> <b>${refCount % 3} / 3</b>\n🔗 <b>ඔබේ Referral Link එක:</b>\n<code>${refLink}</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>(Link එක Tap කර Copy කර Channel / Groups / Friends ලාට Share කරන්න)</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 Share with Friends", url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent("Watch & Download Movies without limits on PixelPop!")}` }],
    ],
  };

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: text,
    reply_markup: keyboard,
  });
}

async function handleReferralStart(env, newUserId, referrerId) {
  if (newUserId === referrerId) {
    await sendReply(env, newUserId, "⚠️ You cannot refer yourself!");
    return;
  }

  const existingUser = await env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(newUserId).first();
  if (!existingUser?.referred_by) {
    await env.DB.prepare(`
      UPDATE users SET referred_by = ? WHERE user_id = ?
    `).bind(referrerId, newUserId).run();
  }

  // Check Force sub
  const isSubscribed = await checkUserSubscription(env, newUserId);
  if (!isSubscribed) {
    await sendForceSubMessage(env, newUserId, "welcome");
  } else {
    await grantReferralIfPending(env, newUserId);
    await sendReply(env, newUserId, "👋 Welcome to PixelPop! Your invite has been registered.");
  }
}

async function grantReferralIfPending(env, userId) {
  const user = await env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(userId).first();
  if (user?.referred_by) {
    const referrerId = user.referred_by;
    // Clear referred_by so it doesn't count again
    await env.DB.prepare(`UPDATE users SET referred_by = NULL WHERE user_id = ?`).bind(userId).run();

    // Increment referrer's count
    await env.DB.prepare(`
      UPDATE users SET referral_count = referral_count + 1 WHERE user_id = ?
    `).bind(referrerId).run();

    const refUser = await env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(referrerId).first();
    const count = refUser?.referral_count || 1;

    // Award 24-hour VIP pass every 3 referrals (stacks automatically)
    if (count % 3 === 0) {
      const oneDay = 24 * 60 * 60 * 1000;
      const currentExpiry = (refUser.is_vip && refUser.vip_until > Date.now()) ? refUser.vip_until : Date.now();
      const newExpiry = currentExpiry + oneDay;

      await env.DB.prepare(`
        UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?
      `).bind(newExpiry, referrerId).run();

      await sendReply(
        env,
        referrerId,
        "🎉 <b>Congratulations!</b>\n3 of your friends have joined! You have been granted a <b>FREE 24-Hour VIP Pass</b>! Enjoy ad-free downloads."
      );
    } else {
      await sendReply(
        env,
        referrerId,
        `🎉 A friend joined via your link! (${count % 3}/3 invited for Free VIP)`
      );
    }
  }
}

// ================= ADMIN HELPERS & BROADCAST =================
async function generateBatchLink(env, chatId) {
  let batchRes;
  try {
    batchRes = await env.DB.prepare(`
      SELECT message_id FROM admin_batch WHERE admin_id = ? ORDER BY id ASC
    `).bind(chatId).all();
  } catch {
    batchRes = await env.DB.prepare(`
      SELECT message_id FROM admin_batch ORDER BY id ASC
    `).all();
  }

  const batch = (batchRes?.results || []).map((r) => r.message_id);

  if (!batch || batch.length === 0) {
    await sendReply(env, chatId, "⚠️ No files in queue! Please forward some files first or use /add <Title>.");
    return;
  }

  const uniqueIds = [...new Set(batch)];

  // Check if admin prepared a custom title
  let title = "PixelPop Release";
  try {
    const draftTitle = await env.DB.prepare(`
      SELECT msg_ids FROM users WHERE user_id = 'admin_title_draft'
    `).first();
    if (draftTitle?.msg_ids) title = draftTitle.msg_ids;
  } catch {}

  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";

  // 🎬 TMDb Auto Poster & Metadata Lookup
  const tmdb = await fetchTmdbInfo(env, title);
  const posterUrl = tmdb?.poster || null;
  const displayTitle = tmdb?.title || title;
  const yearText = tmdb?.year ? ` (${tmdb.year})` : "";
  const ratingText = tmdb?.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
  const overviewText = tmdb?.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n━━━━━━━━━━━━━━━━━━━━\n` : "";

  let channelPostText = "";

  if (uniqueIds.length === 1) {
    // Single file (Movie)
    const token = `b_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(`
      INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(token, displayTitle, posterUrl, JSON.stringify(uniqueIds), chatId, Date.now()).run();

    const link = `https://t.me/${botUsername}?start=${token}`;
    channelPostText = `🎬 <b>${escapeHtml(displayTitle)}</b>${yearText}\n${ratingText}━━━━━━━━━━━━━━━━━━━━\n${overviewText}⚡ <b>VIP Access:</b> Instant 0 Ads (Permanent)\n🆓 <b>Free Access:</b> Watch 5s Sponsor Ad\n━━━━━━━━━━━━━━━━━━━━\n👇 <b>Download Link:</b>\n🔗 <a href="${link}">${escapeHtml(displayTitle)}</a>`;

    const adminKb = {
      inline_keyboard: [[{ text: "📥 Download / ලබාගන්න", url: link }]],
    };

    let sentPhoto = false;
    if (posterUrl && channelPostText.length <= 950) {
      const pRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: posterUrl,
        caption: `🎉 <b>Movie Link Generated!</b>\n\n${channelPostText}\n\n<i>(Directly forward this post to your channel)</i>`,
        parse_mode: "HTML",
        reply_markup: adminKb,
      });
      sentPhoto = pRes.ok;
    }

    if (!sentPhoto) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `🎉 <b>Movie Link Generated!</b>\n\n${channelPostText}\n\n<i>(Directly forward this post to your channel)</i>`,
        reply_markup: adminKb,
      });
    }
  } else {
    // Multi-file (Series / Complete Season)
    // 1. VIP Full Season Pack Link (All episodes in 1-Click)
    const packToken = `b_${crypto.randomUUID().slice(0, 8)}`;
    const packTitle = `${displayTitle} (Complete Season Pack)`;
    await env.DB.prepare(`
      INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(packToken, packTitle, posterUrl, JSON.stringify(uniqueIds), chatId, Date.now()).run();

    const packLink = `https://t.me/${botUsername}?start=${packToken}`;

    // 2. Individual Episode Links for Free Users
    let epLinks = [];
    for (let i = 0; i < uniqueIds.length; i++) {
      const epNum = i + 1;
      const epToken = `b_${crypto.randomUUID().slice(0, 8)}`;
      const epTitle = `${displayTitle} - Episode ${epNum}`;
      await env.DB.prepare(`
        INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(epToken, epTitle, posterUrl, JSON.stringify([uniqueIds[i]]), chatId, Date.now()).run();

      const epLink = `https://t.me/${botUsername}?start=${epToken}`;
      epLinks.push({ epNum, link: epLink });
    }

    // Format stylish Channel Post
    let epListText = epLinks
      .map((e) => `🔹 <b>Episode ${e.epNum < 10 ? "0" + e.epNum : e.epNum}:</b> <a href="${e.link}">Download Episode</a>`)
      .join("\n");

    channelPostText = `🎬 <b>${escapeHtml(displayTitle)}</b>${yearText}\n${ratingText}━━━━━━━━━━━━━━━━━━━━\n${overviewText}👑 <b>VIP Members (Complete Season in 1-Click):</b>\n👉 <a href="${packLink}">⚡ Download Complete Season (${uniqueIds.length} Episodes)</a>\n\n🆓 <b>Free Users (Episode by Episode):</b>\n${epListText}\n━━━━━━━━━━━━━━━━━━━━\n<i>🛡️ Protected content: Forwarding is disabled.</i>`;

    const adminKb = {
      inline_keyboard: [
        [{ text: "👑 Complete Season (VIP Pack)", url: packLink }],
      ],
    };

    let sentPhoto = false;
    if (posterUrl && channelPostText.length <= 950) {
      const pRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: posterUrl,
        caption: `🎉 <b>Series Links Generated!</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>VIP Season Pack Link:</b>\n<code>${packLink}</code>\n\n📢 <b>Ready-to-Post Channel Message:</b>\n\n${channelPostText}`,
        parse_mode: "HTML",
        reply_markup: adminKb,
      });
      sentPhoto = pRes.ok;
    }

    if (!sentPhoto) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `🎉 <b>Series Links Generated!</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>VIP Season Pack Link:</b>\n<code>${packLink}</code>\n\n📢 <b>Ready-to-Post Channel Message:</b>\n\n${channelPostText}`,
        reply_markup: adminKb,
      });
    }
  }

  // Clear admin draft title & batch queue
  try {
    await env.DB.prepare(`DELETE FROM users WHERE user_id = 'admin_title_draft'`).run();
    await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
  } catch {
    await env.DB.prepare(`DELETE FROM admin_batch`).run();
  }
}

async function handleAdminStats(env, chatId) {
  const totalUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE user_id NOT LIKE 'admin_%'`).first();
  const activeVip = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(Date.now()).first();
  const totalBatches = await env.DB.prepare(`SELECT COUNT(*) as c FROM batches`).first();
  const queueSize = await env.DB.prepare(`SELECT COUNT(*) as c FROM deletions`).first();
  const pendingSlips = await env.DB.prepare(`SELECT COUNT(*) as c FROM vip_requests WHERE status = 'pending'`).first();

  const text = `📊 <b>PixelPop System Dashboard:</b>\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Total Registered Users:</b> ${totalUsers?.c || 0}\n👑 <b>Active VIP Members:</b> ${activeVip?.c || 0}\n💳 <b>Pending Bank Slips:</b> ${pendingSlips?.c || 0}\n📦 <b>Total Stored Batches:</b> ${totalBatches?.c || 0}\n🗑️ <b>Deletion Queue Size:</b> ${queueSize?.c || 0}\n━━━━━━━━━━━━━━━━━━━━`;

  await sendReply(env, chatId, text);
}

async function handleBroadcast(env, chatId, broadcastText) {
  const usersRes = await env.DB.prepare(`SELECT user_id FROM users WHERE user_id NOT LIKE 'admin_%' LIMIT 500`).all();
  const users = usersRes.results || [];

  await sendReply(env, chatId, `🚀 Starting broadcast to ${users.length} users...`);

  let count = 0;
  for (const u of users) {
    const res = await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: u.user_id,
      parse_mode: "HTML",
      text: broadcastText,
    });
    if (res.ok) count++;
  }

  await sendReply(env, chatId, `✅ Broadcast complete! Delivered to ${count} / ${users.length} users.`);
}

// ================= TMDB AUTO POSTER & LIVE SEARCH & MOVIE REQUESTS =================
async function fetchTmdbInfo(env, query) {
  if (!env.TMDB_API_KEY) return null;
  try {
    const cleanQuery = query
      .replace(/[\[\(].*?[\]\)]/g, "")
      .replace(/\b(1080p|720p|480p|4k|hdr|bluray|web-dl|hdrip|x264|x265|hevc|season\s*\d+|s\d+e\d+|episode\s*\d+)\b/gi, "")
      .trim();

    if (!cleanQuery) return null;

    const url = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&query=${encodeURIComponent(cleanQuery)}&include_adult=false&language=en-US&page=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const item = (data.results || []).find((r) => r.media_type === "movie" || r.media_type === "tv") || data.results?.[0];
    if (!item) return null;

    const title = item.title || item.name || cleanQuery;
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);
    const poster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
    const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
    let overview = item.overview || "";
    if (overview.length > 250) {
      overview = overview.slice(0, 247) + "...";
    }

    return {
      id: item.id,
      media_type: item.media_type || "movie",
      title,
      year,
      poster,
      rating,
      overview,
    };
  } catch (err) {
    console.error("TMDb fetch error:", err);
    return null;
  }
}

async function handleLiveSearch(env, chatId, query) {
  query = (query || "").trim();
  if (!query || query.length < 2) return;

  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";

  // 1. Search Local Batches in D1
  let batches = [];
  try {
    const searchPattern = `%${query}%`;
    const batchRes = await env.DB.prepare(`
      SELECT * FROM batches 
      WHERE title LIKE ? 
      ORDER BY created_at DESC 
      LIMIT 5
    `).bind(searchPattern).all();
    batches = batchRes?.results || [];
  } catch (e) {
    console.error("Local search error:", e);
  }

  // 2. Query TMDb for Auto Poster & Synopsis
  const tmdb = await fetchTmdbInfo(env, query);

  // Case A: Files found in PixelPop database
  if (batches.length > 0) {
    const title = tmdb?.title || batches[0].title || query;
    const yearStr = tmdb?.year ? ` (${tmdb.year})` : "";
    const ratingStr = tmdb?.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
    const overviewStr = tmdb?.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n━━━━━━━━━━━━━━━━━━━━\n` : "";
    const poster = tmdb?.poster || batches.find((b) => b.poster_url)?.poster_url || null;

    let kbRows = batches.map((b) => [
      { text: `📥 ${b.title || "Download File"}`, url: `https://t.me/${botUsername}?start=${b.token}` },
    ]);

    kbRows.push([{ text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" }]);

    const caption = `🎬 <b>${escapeHtml(title)}</b>${yearStr}\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}🍿 <b>PixelPop Database එකේ හමු වූ Files (${batches.length}):</b>\nපහත Button එකෙන් ලබාගන්න:`;

    if (poster && caption.length <= 950) {
      const photoRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: poster,
        caption: caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: kbRows },
      });
      if (photoRes.ok) return;
    }

    // Fallback text if photo fails or no poster
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: caption,
      reply_markup: { inline_keyboard: kbRows },
    });
    return;
  }

  // Case B: Not found in D1, but found on TMDb
  if (tmdb) {
    const yearStr = tmdb.year ? ` (${tmdb.year})` : "";
    const ratingStr = tmdb.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
    const overviewStr = tmdb.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n` : "";

    const caption = `🎬 <b>${escapeHtml(tmdb.title)}</b>${yearStr}\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}━━━━━━━━━━━━━━━━━━━━\n⚠️ <b>මෙම චිත්‍රපටය තවමත් PixelPop හි නොමැත!</b>\n<i>(This title is not in our database yet)</i>\n\n👇 <b>ඔබට මෙය අවශ්‍ය නම් පහත Button එක ඔබා Request කරන්න:</b>`;

    const cleanTitle = (tmdb.title || query).slice(0, 40);
    const reqKb = {
      inline_keyboard: [
        [{ text: "📢 Request this Movie / අපෙන් ඉල්ලන්න", callback_data: `req_movie_${cleanTitle}` }],
        [{ text: "👑 Get VIP Membership", callback_data: "vip_pay_bank" }],
      ],
    };

    if (tmdb.poster && caption.length <= 950) {
      const photoRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: tmdb.poster,
        caption: caption,
        parse_mode: "HTML",
        reply_markup: reqKb,
      });
      if (photoRes.ok) return;
    }

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: caption,
      reply_markup: reqKb,
    });
    return;
  }

  // Case C: Neither found
  const cleanTitle = query.slice(0, 40);
  const notFoundKb = {
    inline_keyboard: [
      [{ text: "📢 Request Movie / අපෙන් ඉල්ලන්න", callback_data: `req_movie_${cleanTitle}` }],
    ],
  };

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `🔍 <b>'${escapeHtml(query)}' හමු නොවීය!</b>\n━━━━━━━━━━━━━━━━━━━━\nනම නිවැරදිදැයි පරීක්ෂා කර නැවත Search කරන්න.\n\n💡 <b>අපෙන් ඉල්ලීමට:</b>\n<code>/request ${escapeHtml(query)}</code> ලෙස Type කරන්න හෝ පහත Button එක ඔබන්න.`,
    reply_markup: notFoundKb,
  });
}

async function handleMovieRequest(env, chatId, userName, query) {
  query = (query || "").trim();
  if (!query) return;

  await ensureSchema(env);

  let reqId = Date.now();
  try {
    const res = await env.DB.prepare(`
      INSERT INTO requests (user_id, user_name, query, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).bind(chatId, userName, query, Date.now()).run();
    if (res?.meta?.last_row_id) {
      reqId = res.meta.last_row_id;
    }
  } catch (e) {
    console.error("Movie request insert error:", e);
  }

  // User notification
  await sendReply(
    env,
    chatId,
    `✅ <b>Request Received / ඉල්ලීම භාරගන්නා ලදී!</b>\n━━━━━━━━━━━━━━━━━━━━\n🎬 <b>Title:</b> <i>${escapeHtml(query)}</i>\n\nඔබගේ ඉල්ලීම Admin වෙත යොමු කරන ලදී. අප කඩිනමින් මෙය Upload කිරීමට කටයුතු කරන්නෙමු!`
  );

  // Admin notification
  const adminKb = {
    inline_keyboard: [
      [
        { text: "✅ Uploaded (Notify User)", callback_data: `req_fulfill_${reqId}` },
        { text: "❌ Decline", callback_data: `req_decline_${reqId}` },
      ],
    ],
  };

  const adminMsg = `📩 <b>New Movie Request #${reqId}</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${userName} (<code>${chatId}</code>)\n🎬 <b>Requested:</b> <b>${escapeHtml(query)}</b>\n━━━━━━━━━━━━━━━━━━━━`;

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_ID,
    parse_mode: "HTML",
    text: adminMsg,
    reply_markup: adminKb,
  });
}

// ================= GENERAL HELPERS =================
function isUserVipActive(user) {
  if (!user) return false;
  return user.is_vip === 1 && (user.vip_until || 0) > Date.now();
}

async function getUserLang(env, chatId) {
  if (!env.DB) return "si";
  try {
    const u = await env.DB.prepare(`SELECT language FROM users WHERE user_id = ?`).bind(chatId).first();
    return u?.language || "si";
  } catch {
    return "si";
  }
}

async function checkUserSubscription(env, userId) {
  if (!env.FORCE_SUB_CHANNEL_ID) return true;
  if (userId.toString() === env.ADMIN_ID?.toString()) return true;

  try {
    const res = await callTelegram(env.BOT_TOKEN, "getChatMember", {
      chat_id: env.FORCE_SUB_CHANNEL_ID,
      user_id: userId,
    });

    if (!res.ok) return true;
    const status = res.result?.status;
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch {
    return true;
  }
}

async function sendForceSubMessage(env, chatId, payload) {
  const fsubKeyboard = {
    inline_keyboard: [
      [{ text: `📢 Join ${env.FORCE_SUB_CHANNEL_NAME || "Our Channel"}`, url: env.FORCE_SUB_CHANNEL_LINK }],
      [{ text: "🔄 Try Again / නැවත උත්සාහ කරන්න", callback_data: `check_fsub_${payload}` }],
    ],
  };

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `⚠️ <b>Access Denied! Join Required</b>\nFiles ලබා ගැනීමට නම් ඔබ අපගේ ප්‍රධාන Channel එකට සම්බන්ධ විය යුතුය.\nපහත Button එකෙන් Join වී <b>Try Again</b> ඔබන්න!`,
    reply_markup: fsubKeyboard,
  });
}

async function ensureUserExists(env, user) {
  if (!user || !env.DB) return;
  const userId = user.id.toString();
  try {
    await env.DB.prepare(`
      INSERT INTO users (user_id, username, first_name, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name
    `).bind(userId, user.username || null, user.first_name || null, Date.now()).run();
  } catch (err) {
    try {
      await env.DB.prepare(`
        INSERT INTO users (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING
      `).bind(userId).run();
    } catch {}
  }
}

async function ensureSchema(env) {
  if (!env.DB || isSchemaMigrated) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        language TEXT DEFAULT 'si',
        msg_ids TEXT,
        ad_started_at INTEGER,
        delivered INTEGER DEFAULT 0,
        is_vip INTEGER DEFAULT 0,
        vip_until INTEGER DEFAULT 0,
        referred_by TEXT,
        referral_count INTEGER DEFAULT 0,
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS admin_batch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id TEXT,
        message_id INTEGER NOT NULL
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS batches (
        token TEXT PRIMARY KEY,
        title TEXT,
        msg_ids TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        delete_at INTEGER NOT NULL,
        reminded INTEGER DEFAULT 0
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS vip_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        user_name TEXT,
        file_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        telegram_charge_id TEXT,
        status TEXT DEFAULT 'completed',
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        user_name TEXT,
        query TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER
      )
    `).run();

    // Migrations for pre-existing tables created under old schema
    const migrations = [
      "ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'si'",
      "ALTER TABLE users ADD COLUMN username TEXT",
      "ALTER TABLE users ADD COLUMN first_name TEXT",
      "ALTER TABLE users ADD COLUMN is_vip INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN vip_until INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN referral_count INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN referred_by TEXT",
      "ALTER TABLE users ADD COLUMN created_at INTEGER",
      "ALTER TABLE users ADD COLUMN verify_token TEXT",
      "ALTER TABLE users ADD COLUMN ad_verified INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN last_download_at INTEGER DEFAULT 0",
      "ALTER TABLE admin_batch ADD COLUMN admin_id TEXT",
      "ALTER TABLE deletions ADD COLUMN reminded INTEGER DEFAULT 0",
      "ALTER TABLE batches ADD COLUMN poster_url TEXT",
      "ALTER TABLE vip_requests ADD COLUMN plan TEXT DEFAULT 'monthly'",
    ];

    for (const q of migrations) {
      try {
        await env.DB.prepare(q).run();
      } catch {
        // Ignored if column already exists
      }
    }

    isSchemaMigrated = true;
  } catch (err) {
    console.error("Schema ensure error:", err);
  }
}

async function sendReply(env, chatId, htmlText) {
  return callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: htmlText,
  });
}

function escapeHtml(text) {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function callTelegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
