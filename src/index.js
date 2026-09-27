/**
 * PixelPop Telegram File Store Bot (Cloudflare Worker + D1 Database)
 * Features:
 * - Scalable, serverless Cloudflare Worker architecture
 * - Multi-tier Monetization: Telegram Stars (XTR), Local VIP (Bank Slip verification), Rewarded Ads
 * - Viral Referral Engine (Invite 3 friends for Free 24h VIP)
 * - Secure UUID-based Batch Links with full Backward Compatibility for old links
 * - Rich Movie Previews, Bilingual UX (සිංහල & English)
 * - Auto-Deletion (6-hour limit for free users) with Smart 30-minute Expiry Reminders
 * - Admin Broadcast Engine & Real-Time Stats
 */

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

    // Lazy cleanup & reminders on incoming requests as fallback
    ctx.waitUntil(handleScheduledTasks(env));

    // 🔍 1. SYSTEM DIAGNOSTIC TEST (Protected by Admin ID or Secret)
    if (url.pathname === "/test") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.ADMIN_ID) {
        return new Response(JSON.stringify({ error: "Unauthorized access. Pass ?secret=" + (env.ADMIN_ID || "YOUR_ADMIN_ID") }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Auto migrate schema if needed
      await ensureSchema(env);

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
  const text = (msg.text || "").trim();
  const user = msg.from;

  // Track / register user in D1
  await ensureUserExists(env, user);

  // ⭐️ 1. Successful Telegram Stars Payment Receipt
  if (msg.successful_payment) {
    await handleSuccessfulPayment(msg, env);
    return;
  }

  // 📸 2. Photo Upload (Bank Slip for VIP verification)
  if (msg.photo && msg.photo.length > 0) {
    await handleSlipUpload(msg, env);
    return;
  }

  // 👑 3. ADMIN-ONLY COMMANDS & FILE INGESTION
  const isAdmin = chatId === env.ADMIN_ID?.toString();
  if (isAdmin) {
    // A. Forwarded or Direct File Upload to Storage Channel
    if (!text.startsWith("/")) {
      await handleAdminFileUpload(msg, env);
      return;
    }

    // B. Admin Commands
    if (text.startsWith("/add ")) {
      const customTitle = text.replace("/add ", "").trim();
      await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
      await env.DB.prepare(`
        INSERT INTO users (user_id, msg_ids) VALUES ('admin_title_draft', ?)
        ON CONFLICT(user_id) DO UPDATE SET msg_ids = excluded.msg_ids
      `).bind(customTitle).run();
      await sendReply(
        env,
        chatId,
        `🎬 <b>Ready to Add:</b> <i>${escapeHtml(customTitle)}</i>\n━━━━━━━━━━━━━━━━━━━━\nForward all episodes or movie files now. When finished, send /done or click Generate Link.`
      );
      return;
    }

    if (text.startsWith("/done")) {
      await generateBatchLink(env, chatId);
      return;
    }

    if (text.startsWith("/cancel")) {
      await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
      await sendReply(env, chatId, "🗑️ <b>Batch Cleared!</b> / <b>Batch එක ඉවත් කරන ලදී.</b>");
      return;
    }

    if (text.startsWith("/title ")) {
      const customTitle = text.replace("/title ", "").trim();
      await env.DB.prepare(`
        INSERT INTO users (user_id, msg_ids) VALUES ('admin_title_draft', ?)
        ON CONFLICT(user_id) DO UPDATE SET msg_ids = excluded.msg_ids
      `).bind(customTitle).run();
      await sendReply(env, chatId, `🏷️ <b>Batch Title Set:</b> <i>${escapeHtml(customTitle)}</i>\nNow forward your files or click Generate Link.`);
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
    const lang = await getUserLang(env, chatId);
    const helpMsg = lang === "si"
      ? `📖 <b>PixelPop Bot භාවිතා කරන්නේ කෙසේද?</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ Channel එකේ ඇති Movie / Series Link එකක් Click කරන්න.\n2️⃣ Main Channel එකට Join වී සිටින්න.\n3️⃣ <b>නොමිලේ ලබා ගැනීමට:</b> '🎬 Watch Ads' ඔබා තත්පර 5ක් නරඹා 'I have clicked ads ⁉️' ඔබන්න.\n4️⃣ <b>Instant Download:</b> කිසිදු Ad එකක් නැතිව ⭐️ 5 Stars මගින් ක්ෂණිකව ලබාගත හැක.\n\n👑 <b>VIP සාමාජිකත්වය:</b> කිසිදු Ad එකක් නැතිව සහ Files පැය 6කින් මැකී නොයන VIP වීමට /vip භාවිතා කරන්න.`
      : `📖 <b>How to Use PixelPop Bot:</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ Click any Movie/Series link from our channel.\n2️⃣ Ensure you have joined our official channel.\n3️⃣ <b>Free Download:</b> Tap '🎬 Watch Ads', stay 5s, and tap 'I have clicked ads ⁉️'.\n4️⃣ <b>Instant Download:</b> Skip ads instantly with ⭐️ 5 Telegram Stars!\n\n👑 <b>VIP Membership:</b> Get lifetime/30-day ad-free access with permanent file storage via /vip.`;

    await sendReply(env, chatId, helpMsg);
    return;
  }

  // E. /start Command (Deep Link & Referral handling)
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
      const lang = await getUserLang(env, chatId);
      const welcomeText = lang === "si"
        ? `👋 <b>PixelPop File Store වෙත සාදරයෙන් පිළිගනිමු!</b>\n\nMovies සහ TV Series බාගත කර ගැනීමට කරුණාකර අපගේ Channel එකේ ඇති Links භාවිතා කරන්න.\n\n👑 <b>VIP සාමාජිකත්වය:</b> /vip\n👥 <b>නොමිලේ VIP ලබාගන්න:</b> /referral\n🌐 <b>භාෂාව වෙනස් කිරීමට:</b> /language`
        : `👋 <b>Welcome to PixelPop File Store!</b>\n\nPlease use the download links posted on our official channel to access movies and series.\n\n👑 <b>VIP Membership:</b> /vip\n👥 <b>Free VIP Pass:</b> /referral\n🌐 <b>Language:</b> /language`;

      await sendReply(env, chatId, welcomeText);
    }
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
      await sendReply(env, chatId, `❌ Error copying to storage channel: ${res.description || "Unknown"}`);
      return;
    }
  }

  // Insert into admin batch queue
  await env.DB.prepare(`
    INSERT INTO admin_batch (admin_id, message_id) VALUES (?, ?)
  `).bind(chatId, channelMsgId).run();

  const countRes = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM admin_batch WHERE admin_id = ?
  `).bind(chatId).first();

  const adminKb = {
    inline_keyboard: [
      [{ text: "🔗 Generate Link Now / Link එක සාදන්න", callback_data: "admin_done" }],
      [{ text: "🗑️ Cancel Batch / අවලංගු කරන්න", callback_data: "admin_cancel" }],
    ],
  };

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `📥 <b>File Saved to Queue!</b> (ID: <code>${channelMsgId}</code>)\nTotal files in batch: <b>${countRes?.count || 1}</b>\n\nForward more files, or click below to generate link:`,
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
    await env.DB.prepare(`UPDATE users SET language = ? WHERE user_id = ?`).bind(newLang, chatId).run();
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
    await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
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

  // 5. 30-Day VIP Purchase via Stars (150 Stars)
  if (data === "buy_vip_stars_30d") {
    await sendStarsInvoice(env, chatId, {
      title: "👑 30-Day VIP Pass",
      description: "Unlimited ad-free downloads + permanent files for 30 days!",
      payload: "vip_30d",
      starsAmount: 150,
    });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  // 6. VIP Bank Slip Request Initiation
  if (data === "vip_pay_bank") {
    await sendBankPaymentInstructions(env, chatId);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  // 7. Admin VIP Approval / Rejection
  if (data.startsWith("vip_approve_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_approve_", "");
    await handleAdminVipApproval(env, chatId, reqId, true);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "✅ VIP Approved!",
    });
    return;
  }

  if (data.startsWith("vip_reject_") && chatId === env.ADMIN_ID?.toString()) {
    const reqId = data.replace("vip_reject_", "");
    await handleAdminVipApproval(env, chatId, reqId, false);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "❌ VIP Rejected.",
    });
    return;
  }

  // 8. "I have clicked ads" Button Verification
  if (data === "check_ad") {
    await handleAdVerification(env, chatId, cb);
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

  // Check if ad was opened
  if (!user.ad_started_at) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "❌ You haven't clicked the ad button yet!\nඔබ තවමත් 'Watch Ads (for 5s)' Button එක ඔබා නැත!",
      show_alert: true,
    });
    return;
  }

  // 5-second verification
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

    // Save target session in D1
    await env.DB.prepare(`
      INSERT INTO users (user_id, msg_ids, ad_started_at, delivered)
      VALUES (?, ?, NULL, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        msg_ids = excluded.msg_ids,
        ad_started_at = NULL,
        delivered = 0
    `).bind(chatId, JSON.stringify(targetMsgIds)).run();

    // Check if user has active VIP
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

    // Display Rich Preview & Choice Card
    const websiteUrl = env.WEBSITE_URL || "https://pixelpoplk.pages.dev";
    const adUrl = `${websiteUrl}/verify.html?a=${chatId}`;

    const titleDisplay = movieTitle ? `🎬 <b>${escapeHtml(movieTitle)}</b>\n` : "";
    const fileCount = targetMsgIds.length;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🎬 Watch Ad (Free / නොමිලේ)", url: adUrl }],
        [{ text: "✅ I have watched ad ⁉️ / බැලුවා", callback_data: "check_ad" }],
        [{ text: "⚡ Skip Ad with 5 Stars (Instant)", callback_data: `buy_fast_pass_${payload}` }],
        [{ text: "👑 Get VIP (30 Days Unlimited)", callback_data: "vip_pay_bank" }],
      ],
    };

    const previewMsg = `🍿 <b>PixelPop File Ready for Download:</b>\n━━━━━━━━━━━━━━━━━━━━\n${titleDisplay}📁 <b>Total Files:</b> ${fileCount} File(s)\n⚡ <b>Instant Access:</b> Pay 5 Stars to download without ads.\n🆓 <b>Free Access:</b> Click 'Watch Ad', stay 5s, and tap 'I have watched ad'.\n━━━━━━━━━━━━━━━━━━━━`;

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: previewMsg,
      reply_markup: keyboard,
    });
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

  return results;
}

// ================= SCHEDULED CRON TASKS =================
async function handleScheduledTasks(env) {
  if (!env.DB) return;

  const now = Date.now();

  // 1. Send 30-Minute Expiry Reminders
  const thirtyMinsFromNow = now + 30 * 60 * 1000;
  const pendingReminders = await env.DB.prepare(`
    SELECT DISTINCT chat_id FROM deletions
    WHERE delete_at <= ? AND reminded = 0
    LIMIT 20
  `).bind(thirtyMinsFromNow).all();

  if (pendingReminders.results && pendingReminders.results.length > 0) {
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

  // 2. Clean Expired Messages
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
  } else if (payload === "vip_30d") {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + thirtyDays;

    await env.DB.prepare(`
      UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?
    `).bind(expiresAt, chatId).run();

    await sendReply(
      env,
      chatId,
      `🎉 <b>30-Day VIP Pass Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nThank you! You now have unlimited instant downloads without ads, and your files will never be auto-deleted.`
    );
  }
}

// ================= LOCAL VIP & BANK SLIP SYSTEM =================
async function sendVipInfoCard(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "⭐️ Buy with 150 Stars (Instant)", callback_data: "buy_vip_stars_30d" }],
      [{ text: "💳 Bank Transfer / FriMi / eZ Cash (LKR 350)", callback_data: "vip_pay_bank" }],
    ],
  };

  const text = `👑 <b>PixelPop VIP Membership Club</b>\n━━━━━━━━━━━━━━━━━━━━\n🌟 <b>VIP වාසි:</b>\n• කිසිදු Ad එකක් නැත (100% Ad-Free)\n• Files පැය 6කින් මැකී යන්නේ නැත (Permanent Access)\n• One-click Instant Downloads\n\n💰 <b>මිල ගණන්:</b>\n• 30 Days VIP: <b>LKR 350/=</b> හෝ <b>⭐️ 150 Stars</b>\n━━━━━━━━━━━━━━━━━━━━\nපහතින් ඔබට පහසු ගෙවීම් ක්‍රමය තෝරන්න:`;

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: text,
    reply_markup: keyboard,
  });
}

async function sendBankPaymentInstructions(env, chatId) {
  const bankMsg = `💳 <b>Bank Transfer / FriMi / eZ Cash Instructions:</b>\n━━━━━━━━━━━━━━━━━━━━\nගාස්තුව: <b>LKR 350/= (දින 30ක් සඳහා)</b>\n\n🏛️ <b>Bank Details:</b>\n• <b>Bank:</b> Commercial Bank / HNB\n• <b>Account Name:</b> PixelPop LK\n• <b>Account Number:</b> <code>XXXXXXXXXX</code>\n• <b>Branch:</b> Colombo\n\n📱 <b>FriMi / eZ Cash:</b>\n• <b>Mobile:</b> <code>07X XXXXXXX</code>\n━━━━━━━━━━━━━━━━━━━━\n📸 <b>පියවර:</b>\nමුදල් තැන්පත් කළ පසු, ලැබෙන <b>Deposit Slip එකේ හෝ Screenshot එකේ ඡායාරූපයක් (Photo) මෙම Bot වෙත එවන්න.</b>\nඅපගේ Admin පරීක්ෂා කර සුළු වේලාවකින් ඔබගේ VIP සක්‍රීය කරනු ඇත!`;

  await sendReply(env, chatId, bankMsg);
}

async function handleSlipUpload(msg, env) {
  const chatId = msg.chat.id.toString();
  const userName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || "User");
  const highestPhoto = msg.photo[msg.photo.length - 1];
  const fileId = highestPhoto.file_id;

  // Save to DB
  const insertRes = await env.DB.prepare(`
    INSERT INTO vip_requests (user_id, user_name, file_id, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).bind(chatId, userName, fileId, Date.now()).run();

  const reqId = insertRes.meta.last_row_id;

  // Notify User
  await sendReply(
    env,
    chatId,
    "✅ <b>Receipt Received!</b> / ඔබගේ රිසිට්පත ලැබුණි.\nඅපගේ Admin විසින් මෙය පරීක්ෂා කර විනාඩි කිහිපයකින් ඔබගේ VIP Pass එක සක්‍රීය කරනු ඇත."
  );

  // Forward to Admin with Action Buttons
  const adminKb = {
    inline_keyboard: [
      [
        { text: "✅ Approve (30 Days)", callback_data: `vip_approve_${reqId}` },
        { text: "❌ Reject", callback_data: `vip_reject_${reqId}` },
      ],
    ],
  };

  await callTelegram(env.BOT_TOKEN, "sendPhoto", {
    chat_id: env.ADMIN_ID,
    photo: fileId,
    caption: `👑 <b>New VIP Subscription Request #${reqId}</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${userName} (<code>${chatId}</code>)\n💵 <b>Plan:</b> 30-Day VIP (LKR 350)\n━━━━━━━━━━━━━━━━━━━━`,
    parse_mode: "HTML",
    reply_markup: adminKb,
  });
}

async function handleAdminVipApproval(env, adminChatId, reqId, isApproved) {
  const req = await env.DB.prepare(`SELECT * FROM vip_requests WHERE id = ?`).bind(reqId).first();
  if (!req || req.status !== "pending") return;

  if (isApproved) {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + thirtyDays;

    await env.DB.prepare(`
      UPDATE users SET is_vip = 1, vip_until = ? WHERE user_id = ?
    `).bind(expiresAt, req.user_id).run();

    await env.DB.prepare(`UPDATE vip_requests SET status = 'approved' WHERE id = ?`).bind(reqId).run();

    await sendReply(
      env,
      req.user_id,
      "🎉 <b>VIP Membership Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබගේ රිසිට්පත තහවුරු විය. දින 30ක VIP සාමාජිකත්වය සක්‍රීය කර ඇත. කිසිදු Ad එකක් නැතිව Files බාගත කරගත හැක!"
    );

    await sendReply(env, adminChatId, `✅ Approved VIP for User ${req.user_id}`);
  } else {
    await env.DB.prepare(`UPDATE vip_requests SET status = 'rejected' WHERE id = ?`).bind(reqId).run();

    await sendReply(
      env,
      req.user_id,
      "❌ <b>Payment Verification Failed!</b>\nඔබ එවූ රිසිට්පත වලංගු නොවේ. කරුණාකර නිවැරදි රිසිට්පතක් සමඟ නැවත උත්සාහ කරන්න."
    );

    await sendReply(env, adminChatId, `❌ Rejected VIP for User ${req.user_id}`);
  }
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

    // Award 24-hour VIP pass every 3 referrals
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
  const batchRes = await env.DB.prepare(`
    SELECT message_id FROM admin_batch WHERE admin_id = ? ORDER BY id ASC
  `).bind(chatId).all();

  const batch = (batchRes.results || []).map((r) => r.message_id);

  if (!batch || batch.length === 0) {
    await sendReply(env, chatId, "⚠️ No files in queue! Please forward some files first or use /add <Title>.");
    return;
  }

  const uniqueIds = [...new Set(batch)];

  // Check if admin prepared a custom title
  const draftTitle = await env.DB.prepare(`
    SELECT msg_ids FROM users WHERE user_id = 'admin_title_draft'
  `).first();
  const title = draftTitle?.msg_ids || "PixelPop Release";
  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";

  let channelPostText = "";

  if (uniqueIds.length === 1) {
    // Single file (Movie)
    const token = `b_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(`
      INSERT INTO batches (token, title, msg_ids, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(token, title, JSON.stringify(uniqueIds), chatId, Date.now()).run();

    const link = `https://t.me/${botUsername}?start=${token}`;
    channelPostText = `🎬 <b>${escapeHtml(title)}</b>\n━━━━━━━━━━━━━━━━━━━━\n📁 <b>Status:</b> Ready for Download\n⚡ <b>VIP Access:</b> Instant 0 Ads\n🆓 <b>Free Access:</b> Watch 5s Sponsor Ad\n━━━━━━━━━━━━━━━━━━━━\n👇 <b>Download Link:</b>\n🔗 <a href="${link}">${escapeHtml(title)}</a>`;

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `🎉 <b>Movie Link Generated!</b>\n\n${channelPostText}\n\n<i>(Directly forward this post to your channel)</i>`,
      reply_markup: {
        inline_keyboard: [[{ text: "📥 Download / ලබාගන්න", url: link }]],
      },
    });
  } else {
    // Multi-file (Series / Complete Season)
    // 1. VIP Full Season Pack Link (All episodes in 1-Click)
    const packToken = `b_${crypto.randomUUID().slice(0, 8)}`;
    const packTitle = `${title} (Complete Season Pack)`;
    await env.DB.prepare(`
      INSERT INTO batches (token, title, msg_ids, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(packToken, packTitle, JSON.stringify(uniqueIds), chatId, Date.now()).run();

    const packLink = `https://t.me/${botUsername}?start=${packToken}`;

    // 2. Individual Episode Links for Free Users
    let epLinks = [];
    for (let i = 0; i < uniqueIds.length; i++) {
      const epNum = i + 1;
      const epToken = `b_${crypto.randomUUID().slice(0, 8)}`;
      const epTitle = `${title} - Episode ${epNum}`;
      await env.DB.prepare(`
        INSERT INTO batches (token, title, msg_ids, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(epToken, epTitle, JSON.stringify([uniqueIds[i]]), chatId, Date.now()).run();

      const epLink = `https://t.me/${botUsername}?start=${epToken}`;
      epLinks.push({ epNum, link: epLink });
    }

    // Format stylish Channel Post
    let epListText = epLinks
      .map((e) => `🔹 <b>Episode ${e.epNum < 10 ? "0" + e.epNum : e.epNum}:</b> <a href="${e.link}">Download Episode</a>`)
      .join("\n");

    channelPostText = `🎬 <b>${escapeHtml(title)}</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>VIP Members (Complete Season in 1-Click):</b>\n👉 <a href="${packLink}">⚡ Download Complete Season (${uniqueIds.length} Episodes)</a>\n\n🆓 <b>Free Users (Episode by Episode):</b>\n${epListText}\n━━━━━━━━━━━━━━━━━━━━\n<i>🛡️ Protected content: Forwarding is disabled.</i>`;

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `🎉 <b>Series Links Generated!</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>VIP Season Pack Link:</b>\n<code>${packLink}</code>\n\n📢 <b>Ready-to-Post Channel Message:</b>\n\n${channelPostText}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "👑 Complete Season (VIP Pack)", url: packLink }],
        ],
      },
    });
  }

  // Clear admin draft title & batch queue
  await env.DB.prepare(`DELETE FROM users WHERE user_id = 'admin_title_draft'`).run();
  await env.DB.prepare(`DELETE FROM admin_batch WHERE admin_id = ?`).bind(chatId).run();
}

async function handleAdminStats(env, chatId) {
  const totalUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first();
  const activeVip = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(Date.now()).first();
  const totalBatches = await env.DB.prepare(`SELECT COUNT(*) as c FROM batches`).first();
  const queueSize = await env.DB.prepare(`SELECT COUNT(*) as c FROM deletions`).first();

  const text = `📊 <b>PixelPop System Dashboard:</b>\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Total Registered Users:</b> ${totalUsers?.c || 0}\n👑 <b>Active VIP Members:</b> ${activeVip?.c || 0}\n📦 <b>Total Stored Batches:</b> ${totalBatches?.c || 0}\n🗑️ <b>Deletion Queue Size:</b> ${queueSize?.c || 0}\n━━━━━━━━━━━━━━━━━━━━`;

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
    const status = res.result.status;
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
    // Fallback: If table is not migrated with new columns yet, insert user_id only
    try {
      await env.DB.prepare(`
        INSERT INTO users (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING
      `).bind(userId).run();
    } catch {}
  }
}

async function ensureSchema(env) {
  if (!env.DB) return;
  try {
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

    // Auto-add new columns to existing users & deletions tables if missing
    const migrations = [
      "ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'si'",
      "ALTER TABLE users ADD COLUMN username TEXT",
      "ALTER TABLE users ADD COLUMN first_name TEXT",
      "ALTER TABLE users ADD COLUMN is_vip INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN vip_until INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN referral_count INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN referred_by TEXT",
      "ALTER TABLE users ADD COLUMN created_at INTEGER",
      "ALTER TABLE deletions ADD COLUMN reminded INTEGER DEFAULT 0",
    ];

    for (const q of migrations) {
      try {
        await env.DB.prepare(q).run();
      } catch {
        // Ignored if column already exists
      }
    }
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
