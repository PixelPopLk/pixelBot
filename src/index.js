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

// 🛡️ High-Performance Sliding Window In-Memory Rate Limiter (Anti-Flood / Anti-DDoS)
const rateLimitMap = new Map();

function isRateLimited(userId, limit = 25, windowMs = 60000, minIntervalMs = 700) {
  if (!userId) return false;
  const now = Date.now();
  const rec = rateLimitMap.get(userId.toString()) || { count: 0, windowStart: now, lastAction: 0 };

  // Min interval check (prevents rapid-fire bot requests under 700ms)
  if (now - rec.lastAction < minIntervalMs) {
    return true;
  }

  // Sliding window check
  if (now - rec.windowStart > windowMs) {
    rec.count = 1;
    rec.windowStart = now;
  } else {
    rec.count++;
    if (rec.count > limit) {
      return true;
    }
  }

  rec.lastAction = now;
  rateLimitMap.set(userId.toString(), rec);

  // Periodic eviction to conserve Cloudflare Worker isolate memory
  if (rateLimitMap.size > 5000) {
    for (const [k, v] of rateLimitMap.entries()) {
      if (now - v.lastAction > 180000) rateLimitMap.delete(k);
    }
  }

  return false;
}

function isAuthorizedAdmin(userId, env) {
  if (!userId) return false;
  const uid = userId.toString();
  if (env.ADMIN_ID && uid === env.ADMIN_ID.toString()) return true;
  if (env.CO_ADMINS) {
    const coList = env.CO_ADMINS.split(",").map((s) => s.trim());
    if (coList.includes(uid)) return true;
  }
  return false;
}

async function isUserBanned(env, userId) {
  if (!env.DB || !userId) return false;
  try {
    const u = await env.DB.prepare(`SELECT is_banned FROM users WHERE user_id = ?`).bind(userId.toString()).first();
    return u?.is_banned === 1;
  } catch {
    return false;
  }
}

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

    // 🛡️ 2. AD CLICK & VERIFICATION RECORD (Strict Cryptographic Token-Only Anti-Bypass)
    if (url.pathname === "/verify" || url.pathname === "/verify_ad" || url.pathname === "/ad_started") {
      const userId = url.searchParams.get("u") || url.searchParams.get("a");
      const token = url.searchParams.get("t");

      if (!userId || !token) {
        return new Response(
          JSON.stringify({ ok: false, error: "Access denied. Valid user ID and secret token are required." }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (env.DB) {
        const user = await env.DB.prepare(`
          SELECT verify_token, token_created_at FROM users WHERE user_id = ?
        `).bind(userId.toString()).first();

        if (!user || !user.verify_token || user.verify_token !== token) {
          return new Response(
            JSON.stringify({ ok: false, error: "Invalid or expired verification token." }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Token TTL Check (15-Minute Expiry Limit)
        const TOKEN_TTL_MS = 15 * 60 * 1000;
        if (user.token_created_at && (Date.now() - user.token_created_at > TOKEN_TTL_MS)) {
          return new Response(
            JSON.stringify({ ok: false, error: "Verification token expired (15-minute limit exceeded). Please re-open the link from the bot." }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        await env.DB.prepare(`
          UPDATE users SET ad_verified = 1, ad_started_at = ? WHERE user_id = ?
        `).bind(Date.now(), userId.toString()).run();

        return new Response(JSON.stringify({ ok: true, status: "verified" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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

  // 2. Telegram Inline Query Search Mode (@PixelPopStorebot <query>)
  if (update.inline_query) {
    await handleInlineQuery(update.inline_query, env);
    return;
  }

  // 3. Inline Callback Queries with Anti-Flood Protection
  if (update.callback_query) {
    const fromId = update.callback_query.from.id.toString();
    if (isRateLimited(fromId, 35, 60000, 350)) {
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: "⏳ Slow down! Please wait a moment. / කරුණාකර තත්පරයක් රැඳී සිටින්න.",
        show_alert: false,
      });
      return;
    }
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  // 4. Normal Message Updates with Rate Limiting & Ban Filter
  if (update.message) {
    const fromId = update.message.from ? update.message.from.id.toString() : update.message.chat.id.toString();
    const isGrp = update.message.chat?.type === "group" || update.message.chat?.type === "supergroup";
    if (isRateLimited(fromId, 25, 60000, 700) && !isAuthorizedAdmin(fromId, env)) {
      if (!isGrp) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: fromId,
          text: "⏳ <b>Anti-Spam Alert / කරුණාකර රැඳී සිටින්න:</b>\nඔබ ඉතා වේගයෙන් Messages එවමින් සිටී. තත්පර කිහිපයකින් නැවත උත්සාහ කරන්න.",
          parse_mode: "HTML",
        });
      }
      return;
    }
    await handleMessage(update.message, env);
    return;
  }
}

// ================= MESSAGE HANDLER =================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id.toString();
  const chatType = msg.chat.type || "private";
  const isGroup = chatType === "group" || chatType === "supergroup";
  const text = (msg.text || msg.caption || "").trim();
  const sender = msg.from;
  const senderId = sender ? sender.id.toString() : chatId;

  // Track / register user in D1 safely
  if (sender) {
    try {
      await ensureUserExists(env, sender);
    } catch (err) {
      console.error("ensureUserExists error:", err);
    }
  }

  // 🛡️ Security Check: Blacklist / Banned User Filter
  const banned = await isUserBanned(env, senderId);
  if (banned && !isAuthorizedAdmin(senderId, env)) {
    // Silently ignore banned users
    return;
  }

  // Check if bot was added to a group/supergroup
  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    const botUser = (env.BOT_USERNAME || "PixelPopStorebot").toLowerCase();
    const isBotAdded = msg.new_chat_members.some(
      (m) => m.is_bot && (m.username?.toLowerCase() === botUser || (env.BOT_ID && m.id.toString() === env.BOT_ID))
    );
    if (isBotAdded) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `👋 <b>PixelPop Bot is now active in this group!</b>\n━━━━━━━━━━━━━━━━━━━━\n🍿 <b>චිත්‍රපට හෝ TV Series සෙවීමට:</b>\nඕනෑම Movie හෝ Series නමක් මෙහි Type කරන්න (උදා: <code>Avatar</code>, <code>Stranger Things</code>, <code>Loki</code>).\n\n<i>Type any title to search and download directly via @${env.BOT_USERNAME || "PixelPopStorebot"}!</i>`,
      });
      return;
    }
  }

  // ⭐️ 1. Successful Telegram Stars Payment Receipt
  if (msg.successful_payment) {
    await handleSuccessfulPayment(msg, env);
    return;
  }

  const isAdmin = !isGroup && isAuthorizedAdmin(senderId, env);

  // 👑 2. ADMIN & CO-ADMIN COMMANDS & FILE INGESTION
  if (isAdmin) {
    // Master Interactive Admin Control Panel
    if (text === "/admin" || text === "/panel" || text === "/dashboard") {
      await sendAdminDashboard(env, chatId);
      return;
    }

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

    // 🚫 Ban & Unban Commands
    if (text.startsWith("/ban ")) {
      const parts = text.replace("/ban ", "").trim().split(" ");
      const targetUserId = parts[0];
      const reason = parts.slice(1).join(" ") || "Violating bot terms and policies";
      if (!targetUserId) {
        await sendReply(env, chatId, "⚠️ Usage: <code>/ban USER_ID [Reason]</code>");
        return;
      }
      await env.DB.prepare(`UPDATE users SET is_banned = 1 WHERE user_id = ?`).bind(targetUserId).run();
      await sendReply(env, chatId, `🚫 <b>User Banned!</b>\nTarget: <code>${targetUserId}</code>\nReason: <i>${escapeHtml(reason)}</i>`);
      try {
        await sendReply(env, targetUserId, `🚫 <b>Your account has been suspended!</b>\nReason: ${escapeHtml(reason)}\nContact admin if you believe this was an error.`);
      } catch {}
      return;
    }

    if (text.startsWith("/unban ")) {
      const targetUserId = text.replace("/unban ", "").trim();
      if (!targetUserId) {
        await sendReply(env, chatId, "⚠️ Usage: <code>/unban USER_ID</code>");
        return;
      }
      await env.DB.prepare(`UPDATE users SET is_banned = 0 WHERE user_id = ?`).bind(targetUserId).run();
      await sendReply(env, chatId, `✅ <b>User Restored!</b>\nUser <code>${targetUserId}</code> is now unbanned.`);
      try {
        await sendReply(env, targetUserId, `✅ <b>Account Restored!</b>\nYou may now continue using PixelPop File Store.`);
      } catch {}
      return;
    }

    // 📢 Targeted Segmented Broadcast Commands (Text or Reply Copy)
    if (text.startsWith("/broadcast_free")) {
      const broadcastMsg = text.replace(/^\/broadcast_free\s*/i, "").trim();
      if (!broadcastMsg && msg.reply_to_message) {
        await handleBroadcast(env, chatId, msg.reply_to_message.message_id, "free", true);
      } else if (broadcastMsg) {
        await handleBroadcast(env, chatId, broadcastMsg, "free", false);
      } else {
        await sendReply(env, chatId, "⚠️ <b>Usage:</b>\n<code>/broadcast_free Your message</code>\nහෝ ඕනෑම message/photo එකකට reply කර <code>/broadcast_free</code> යවන්න.");
      }
      return;
    }

    if (text.startsWith("/broadcast_vip")) {
      const broadcastMsg = text.replace(/^\/broadcast_vip\s*/i, "").trim();
      if (!broadcastMsg && msg.reply_to_message) {
        await handleBroadcast(env, chatId, msg.reply_to_message.message_id, "vip", true);
      } else if (broadcastMsg) {
        await handleBroadcast(env, chatId, broadcastMsg, "vip", false);
      } else {
        await sendReply(env, chatId, "⚠️ <b>Usage:</b>\n<code>/broadcast_vip Your message</code>\nහෝ ඕනෑම message/photo එකකට reply කර <code>/broadcast_vip</code> යවන්න.");
      }
      return;
    }

    if (text.startsWith("/broadcast")) {
      const broadcastMsg = text.replace(/^\/broadcast\s*/i, "").trim();
      if (!broadcastMsg && msg.reply_to_message) {
        await handleBroadcast(env, chatId, msg.reply_to_message.message_id, "all", true);
      } else if (broadcastMsg) {
        await handleBroadcast(env, chatId, broadcastMsg, "all", false);
      } else {
        await sendReply(env, chatId, "⚠️ <b>Usage:</b>\n<code>/broadcast Your message</code>\nහෝ ඕනෑම message/photo එකකට reply කර <code>/broadcast</code> යවන්න.");
      }
      return;
    }

    // 👤 Direct Message to a Specific User (/msg or /dm)
    if (text.startsWith("/msg ") || text.startsWith("/dm ") || text.startsWith("/send ")) {
      const parts = text.split(" ");
      const targetUserId = parts[1]?.trim();
      const content = parts.slice(2).join(" ").trim();

      if (!targetUserId) {
        await sendReply(env, chatId, "⚠️ <b>Usage:</b> <code>/msg &lt;USER_ID&gt; &lt;Message&gt;</code>\nඋදා: <code>/msg 123456789 Hello kasun, your VIP is active!</code>");
        return;
      }

      if (!content && msg.reply_to_message) {
        await handleDirectMessage(env, chatId, targetUserId, null, msg.reply_to_message.message_id);
      } else if (content) {
        await handleDirectMessage(env, chatId, targetUserId, content, null);
      } else {
        await sendReply(env, chatId, "⚠️ කරුණාකර යැවීමට අවශ්‍ය පණිවිඩය Type කරන්න හෝ Message එකකට Reply කර <code>/msg " + targetUserId + "</code> ලෙස යවන්න.");
      }
      return;
    }
  }

  // ⛔ 2.1 Security Lockdown: Block unauthorized users attempting admin commands
  if (!isAdmin && (
    text === "/admin" || text === "/panel" || text === "/dashboard" ||
    text.startsWith("/add") || text === "/done" || text === "/cancel" ||
    text.startsWith("/title") || text === "/stats" ||
    text.startsWith("/ban") || text.startsWith("/unban") ||
    text.startsWith("/broadcast") || text.startsWith("/msg") ||
    text.startsWith("/dm") || text.startsWith("/send")
  )) {
    await sendReply(
      env,
      chatId,
      "⛔ <b>Access Denied! / ප්‍රවේශය ප්‍රතික්ෂේප විය!</b>\n━━━━━━━━━━━━━━━━━━━━\nමෙම Admin Control Panel එක Bot Owner ට පමණක් සීමා කර ඇත.\nඔබට මෙයට ඇතුළු වීමට අවසර නැත."
    );
    return;
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

  // G. /search or /find Command (Explicit Search)
  if (text.startsWith("/search ") || text.startsWith("/find ")) {
    const query = text.replace(/^\/(search|find)\s+/i, "").trim();
    await handleLiveSearch(env, chatId, query, msg.message_id, isGroup, true);
    return;
  }

  // H. /start Command (Deep Link & Referral handling)
  if (text.startsWith("/start")) {
    if (isGroup) {
      const botUsername = env.BOT_USERNAME || "PixelPopStorebot";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        reply_to_message_id: msg.message_id,
        parse_mode: "HTML",
        text: `👋 <b>PixelPop Bot is active!</b>\nSearch any movie or series by typing its name in this group, or open @${botUsername} in private to manage downloads.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🤖 Open Bot in Private", url: `https://t.me/${botUsername}` }],
          ],
        },
      });
      return;
    }

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
        ? `👋 <b>PixelPop File Store වෙත සාදරයෙන් පිළිගනිමු!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔍 <b>Live Search:</b> ඕනෑම චිත්‍රපටයක හෝ TV Series එකක නම මෙහි Type කර Poster එක හා Links ලබාගන්න!\n\n👑 <b>VIP සාමාජිකත්වය:</b> /vip\n🎬 <b>චිත්‍රපට ඉල්ලීමට:</b> /request\n👥 <b>නොමිලේ VIP ලබාගන්න:</b> /referral\n🛡️ <b>Backup Bot:</b> @${backupBot}\n🌐 <b>භාෂාව වෙනස් කිරීමට:</b> /language`
        : `👋 <b>Welcome to PixelPop File Store!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔍 <b>Live Search:</b> Simply type any Movie / Series name here to search!\n\n👑 <b>VIP Membership:</b> /vip\n🎬 <b>Request Movies:</b> /request\n👥 <b>Free VIP Pass:</b> /referral\n🛡️ <b>Backup Bot:</b> @${backupBot}\n🌐 <b>Language:</b> /language`;

      await sendReply(env, chatId, welcomeText);
    }
    return;
  }

  // 🔍 5. IN-BOT & IN-GROUP LIVE SEARCH (PLAIN TEXT - NO COMMAND NEEDED)
  if (!text.startsWith("/") && text.length >= 2) {
    const botUser = (env.BOT_USERNAME || "PixelPopStorebot").toLowerCase();
    let query = text.replace(new RegExp(`@${botUser}\\b`, "gi"), "").trim();
    if (query.length < 2) return;

    if (isGroup) {
      const commonChatWords = new Set([
        "hi", "hello", "hey", "ok", "okay", "gm", "gn", "yes", "no", "thanks", "thank",
        "pls", "please", "kawda", "mokakda", "ha", "ela", "ado", "machan", "mcn", "ko",
        "danna", "link", "links", "admin", "help", "bot", "bye", "good", "night", "morning",
        "sup", "yo", "hmm", "hmmm", "ah", "oh", "wow", "omg", "lol", "k", "kk", "gd", "thx"
      ]);
      if (commonChatWords.has(query.toLowerCase())) {
        return;
      }
    }

    await handleLiveSearch(env, chatId, query, msg.message_id, isGroup, false);
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

  // 1.5 Master Admin Control Panel Callbacks (Strictly Protected)
  if (data.startsWith("adm_")) {
    await handleAdminPanelCallback(cb, env);
    return;
  }

  // 2. Admin Done / Cancel
  if (data === "admin_done" && isAuthorizedAdmin(chatId, env)) {
    await generateBatchLink(env, chatId);
    return;
  }

  if (data === "admin_cancel" && isAuthorizedAdmin(chatId, env)) {
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
  if (data.startsWith("vip_approve_weekly_") && isAuthorizedAdmin(chatId, env)) {
    const reqId = data.replace("vip_approve_weekly_", "");
    await handleAdminVipApproval(env, chatId, reqId, "weekly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Weekly VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_approve_monthly_") && isAuthorizedAdmin(chatId, env)) {
    const reqId = data.replace("vip_approve_monthly_", "");
    await handleAdminVipApproval(env, chatId, reqId, "monthly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Monthly VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_approve_lifetime_") && isAuthorizedAdmin(chatId, env)) {
    const reqId = data.replace("vip_approve_lifetime_", "");
    await handleAdminVipApproval(env, chatId, reqId, "lifetime");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "👑 Lifetime VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_approve_") && isAuthorizedAdmin(chatId, env)) {
    const reqId = data.replace("vip_approve_", "");
    await handleAdminVipApproval(env, chatId, reqId, "monthly");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ VIP Approved!" });
    return;
  }

  if (data.startsWith("vip_reject_") && isAuthorizedAdmin(chatId, env)) {
    const reqId = data.replace("vip_reject_", "");
    await handleAdminVipApproval(env, chatId, reqId, "reject");
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "❌ VIP Rejected." });
    return;
  }

  // 8. Movie Request Admin Actions & User Button Request
  if (data.startsWith("req_fulfill_") && isAuthorizedAdmin(chatId, env)) {
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

  if (data.startsWith("req_decline_") && isAuthorizedAdmin(chatId, env)) {
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

  // 10. Interactive Movie & Series & Quality Browser Callbacks
  if (data.startsWith("br_tab_mov_")) {
    const token = data.replace("br_tab_mov_", "");
    await handleSwitchTab(env, cb, token, "movies");
    return;
  }

  if (data.startsWith("br_tab_ser_")) {
    const token = data.replace("br_tab_ser_", "");
    await handleSwitchTab(env, cb, token, "series");
    return;
  }

  if (data.startsWith("br_mov_")) {
    const token = data.replace("br_mov_", "");
    await handleBrowseMovieQuality(env, cb, token);
    return;
  }

  if (data.startsWith("br_mq_")) {
    // format: br_mq_${chosenToken}_${rootToken}
    const parts = data.split("_");
    const chosenToken = parts[2];
    const rootToken = parts[3] || chosenToken;
    await handleConfirmMovieDownload(env, cb, chosenToken, rootToken);
    return;
  }

  if (data.startsWith("br_ser_")) {
    const token = data.replace("br_ser_", "");
    await handleBrowseSeriesSeasons(env, cb, token);
    return;
  }

  if (data.startsWith("br_sea_")) {
    const parts = data.split("_");
    const token = parts[2];
    const seasonNum = parseInt(parts[3] || "1", 10);
    await handleBrowseSeasonEpisodes(env, cb, token, seasonNum);
    return;
  }

  if (data.startsWith("br_ep_")) {
    const parts = data.split("_");
    const epToken = parts[2];
    const parentToken = parts[3] || epToken;
    const seasonNum = parseInt(parts[4] || "1", 10);
    await handleBrowseEpisodeQuality(env, cb, epToken, parentToken, seasonNum);
    return;
  }

  if (data.startsWith("br_eq_")) {
    // format: br_eq_${chosenToken}_${parentToken}_${seasonNum}
    const parts = data.split("_");
    const chosenToken = parts[2];
    const parentToken = parts[3] || chosenToken;
    const seasonNum = parseInt(parts[4] || "1", 10);
    await handleConfirmEpisodeDownload(env, cb, chosenToken, parentToken, seasonNum);
    return;
  }

  if (data.startsWith("req_search_")) {
    const rawSearch = decodeURIComponent(data.replace("req_search_", ""));
    const userName = cb.from.username ? `@${cb.from.username}` : (cb.from.first_name || "User");
    await handleMovieRequest(env, chatId, userName, rawSearch);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "✅ චිත්‍රපටය Admin වෙත යොමු කරන ලදී! ඉක්මනින් එක් කරනු ඇත.",
      show_alert: true,
    });
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

    // Save target session in D1 + generate fresh secret verification token with TTL timestamp
    const verifyToken = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const tokenCreatedAt = Date.now();

    await env.DB.prepare(`
      INSERT INTO users (user_id, msg_ids, ad_started_at, delivered, ad_verified, verify_token, token_created_at)
      VALUES (?, ?, NULL, 0, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        msg_ids = excluded.msg_ids,
        ad_started_at = NULL,
        delivered = 0,
        ad_verified = 0,
        verify_token = excluded.verify_token,
        token_created_at = excluded.token_created_at
    `).bind(chatId, JSON.stringify(targetMsgIds), verifyToken, tokenCreatedAt).run();

    // Check if user has active VIP (no cooldown, no daily limits, no ads)
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

    const now = Date.now();

    // 🛑 FREE TIER DAILY DOWNLOAD QUOTA ENFORCEMENT (If enabled, maxDaily > 0)
    const maxDaily = parseInt(env.FREE_DAILY_LIMIT || "0", 10);
    let dailyDownloads = user?.daily_downloads || 0;
    let quotaResetAt = user?.quota_reset_at || 0;

    if (maxDaily > 0) {
      // Reset daily quota if 24-hour cycle has passed
      if (!quotaResetAt || now >= quotaResetAt) {
        dailyDownloads = 0;
        quotaResetAt = now + 24 * 60 * 60 * 1000;
        await env.DB.prepare(`
          UPDATE users SET daily_downloads = 0, quota_reset_at = ? WHERE user_id = ?
        `).bind(quotaResetAt, chatId).run();
      }

      if (dailyDownloads >= maxDaily) {
        const remainingMs = Math.max(0, quotaResetAt - now);
        const resetHours = Math.ceil(remainingMs / (60 * 60 * 1000));

        const quotaKeyboard = {
          inline_keyboard: [
            [{ text: "🗓️ Weekly Pass (Rs. 100 / 7d)", callback_data: "vip_plan_weekly" }],
            [{ text: "🗓️ Monthly Pass (Rs. 300 / 30d)", callback_data: "vip_plan_monthly" }],
            [{ text: "👑 Lifetime VIP (Rs. 2500)", callback_data: "vip_plan_lifetime" }],
            [{ text: "⭐️ Unlock with Telegram Stars", callback_data: "vip_stars_menu" }],
          ],
        };

        const titleDisplay = movieTitle ? `🎬 <b>${escapeHtml(movieTitle)}</b>\n` : "";
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text: `🛑 <b>Daily Free Download Limit Reached! (${dailyDownloads}/${maxDaily})</b>\n━━━━━━━━━━━━━━━━━━━━\n${titleDisplay}ඔබ අද දිනට හිමි නොමිලේ Download Limit එක (Files ${maxDaily}) සම්පූර්ණ කර ඇත.\n\n⏰ <b>Quota Reset:</b> තවත් පැය <b>${resetHours}කින්</b> නොමිලේ Downloads නැවත ලැබෙනු ඇත.\n\n👑 <b>ලිමිට් නැතිව දැන්ම දිගටම බලන්න:</b>\nWeekly (Rs. 100) හෝ Monthly (Rs. 300) VIP ලබාගෙන Unlimited Downloads ලබාගන්න!`,
          reply_markup: quotaKeyboard,
        });
        return;
      }
    }

    // 🕐 COOLDOWN CHECK for Free Users (5 minutes between downloads)
    const COOLDOWN_MS = 5 * 60 * 1000;
    const lastDownload = user?.last_download_at || 0;
    const timePassed = now - lastDownload;

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

    const quotaStatus = maxDaily > 0 ? `📊 <b>Today's Free Downloads:</b> ${dailyDownloads} / ${maxDaily}\n` : "";
    const previewMsg = `🍿 <b>PixelPop File Ready for Download:</b>\n━━━━━━━━━━━━━━━━━━━━\n${titleDisplay}📁 <b>Total Files:</b> ${fileCount} File(s)\n${quotaStatus}⚡ <b>Instant Access:</b> Pay 5 Stars to download without ads.\n🆓 <b>Free Access:</b> Click 'Watch Ad', stay 5s, and tap 'I have watched ad'.\n━━━━━━━━━━━━━━━━━━━━`;

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

  // ⏱️ Record download timestamp, increment daily downloads quota, and invalidate verify_token (single use)
  await env.DB.prepare(`
    UPDATE users 
    SET last_download_at = ?, daily_downloads = daily_downloads + 1, verify_token = NULL 
    WHERE user_id = ?
  `).bind(Date.now(), chatId).run();

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

  // 4. Midnight Daily Executive Audit Report (Sent automatically once per day to Admin)
  try {
    const todayStr = new Date(now).toISOString().slice(0, 10);
    const lastAudit = await env.DB.prepare(`SELECT msg_ids FROM users WHERE user_id = 'last_audit_date'`).first();
    if (lastAudit?.msg_ids !== todayStr && env.ADMIN_ID) {
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const newVips = await env.DB.prepare(`SELECT COUNT(*) as c FROM vip_requests WHERE status = 'approved' AND created_at >= ?`).bind(oneDayAgo).first();
      const starsRevenue = await env.DB.prepare(`SELECT SUM(amount) as s FROM payments WHERE currency = 'XTR' AND created_at >= ?`).bind(oneDayAgo).first();
      const pendingSlips = await env.DB.prepare(`SELECT COUNT(*) as c FROM vip_requests WHERE status = 'pending'`).first();
      const pendingReqs = await env.DB.prepare(`SELECT COUNT(*) as c FROM requests WHERE status = 'pending'`).first();
      const activeVipTotal = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(now).first();

      const auditMsg = `🌅 <b>PixelPop Daily Business Briefing (${todayStr})</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>Total Active VIPs:</b> ${activeVipTotal?.c || 0}\n✨ <b>New VIP Approvals (24h):</b> ${newVips?.c || 0}\n⭐️ <b>Stars Revenue (24h):</b> ${starsRevenue?.s || 0} Stars\n💳 <b>Pending Bank Slips:</b> ${pendingSlips?.c || 0}\n🎬 <b>Pending Movie Requests:</b> ${pendingReqs?.c || 0}\n━━━━━━━━━━━━━━━━━━━━\n<i>System Status: Operational 100%</i>`;

      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        parse_mode: "HTML",
        text: auditMsg,
      });

      await env.DB.prepare(`
        INSERT INTO users (user_id, msg_ids) VALUES ('last_audit_date', ?)
        ON CONFLICT(user_id) DO UPDATE SET msg_ids = excluded.msg_ids
      `).bind(todayStr).run();
    }
  } catch (err) {
    console.error("Scheduled audit report error:", err);
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
    try {
      await env.DB.prepare(`
        INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at, series_name, season, episode)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0)
      `).bind(token, displayTitle, posterUrl, JSON.stringify(uniqueIds), chatId, Date.now()).run();
    } catch {
      await env.DB.prepare(`
        INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(token, displayTitle, posterUrl, JSON.stringify(uniqueIds), chatId, Date.now()).run();
    }

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
    const titleMeta = parseMediaTitle(displayTitle);
    const seriesRoot = titleMeta.isSeries && titleMeta.seriesName ? titleMeta.seriesName : displayTitle;
    const detectedSeason = titleMeta.season || 1;

    // 1. VIP Full Season Pack Link (All episodes in 1-Click)
    const packToken = `b_${crypto.randomUUID().slice(0, 8)}`;
    const packTitle = `${seriesRoot} Season ${detectedSeason} (Complete Season Pack)`;
    try {
      await env.DB.prepare(`
        INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at, series_name, season, episode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(packToken, packTitle, posterUrl, JSON.stringify(uniqueIds), chatId, Date.now(), seriesRoot, detectedSeason).run();
    } catch {
      await env.DB.prepare(`
        INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(packToken, packTitle, posterUrl, JSON.stringify(uniqueIds), chatId, Date.now()).run();
    }

    const packLink = `https://t.me/${botUsername}?start=${packToken}`;

    // 2. Individual Episode Links for Free Users
    let epLinks = [];
    for (let i = 0; i < uniqueIds.length; i++) {
      const epNum = i + 1;
      const epToken = `b_${crypto.randomUUID().slice(0, 8)}`;
      const epTitle = `${seriesRoot} S${detectedSeason < 10 ? "0" + detectedSeason : detectedSeason}E${epNum < 10 ? "0" + epNum : epNum}`;
      try {
        await env.DB.prepare(`
          INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at, series_name, season, episode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(epToken, epTitle, posterUrl, JSON.stringify([uniqueIds[i]]), chatId, Date.now(), seriesRoot, detectedSeason, epNum).run();
      } catch {
        await env.DB.prepare(`
          INSERT INTO batches (token, title, poster_url, msg_ids, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(epToken, epTitle, posterUrl, JSON.stringify([uniqueIds[i]]), chatId, Date.now()).run();
      }

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

// ================= MASTER INTERACTIVE ADMIN DASHBOARD =================
async function sendAdminDashboard(env, chatId, editCb = null) {
  let totalUsers = { c: 0 };
  let activeVip = { c: 0 };
  let pendingSlips = { c: 0 };
  let pendingRequests = { c: 0 };
  let todayDownloads = { total: 0 };
  let queueCount = 0;

  try {
    totalUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE user_id NOT LIKE 'admin_%'`).first();
    activeVip = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(Date.now()).first();
    pendingSlips = await env.DB.prepare(`SELECT COUNT(*) as c FROM vip_requests WHERE status = 'pending'`).first();
    pendingRequests = await env.DB.prepare(`SELECT COUNT(*) as c FROM requests WHERE status = 'pending'`).first();
    todayDownloads = await env.DB.prepare(`SELECT SUM(daily_downloads) as total FROM users WHERE daily_downloads > 0`).first();

    const qRes = await env.DB.prepare(`SELECT COUNT(*) as c FROM admin_batch WHERE admin_id = ?`).bind(chatId).first();
    queueCount = qRes?.c || 0;
  } catch (err) {
    console.error("sendAdminDashboard query error:", err);
  }

  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";
  const text = `🎛️ <b>PixelPop Master Admin Control Panel</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>Owner:</b> <code>${chatId}</code>\n🤖 <b>Bot:</b> @${botUsername}\n\n📊 <b>Quick Overview:</b>\n• 👥 <b>Total Users:</b> <b>${totalUsers?.c || 0}</b>\n• 👑 <b>Active VIPs:</b> <b>${activeVip?.c || 0}</b>\n• 📥 <b>Today's Downloads:</b> <b>${todayDownloads?.total || 0}</b>\n• 📩 <b>Pending Requests:</b> <b>${pendingRequests?.c || 0}</b>\n• 💳 <b>Pending Slips:</b> <b>${pendingSlips?.c || 0}</b>\n• 📦 <b>Files in Queue:</b> <b>${queueCount}</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>පහත Buttons මගින් Bot සම්පූර්ණයෙන්ම Manage කරන්න:</i>`;

  const kb = {
    inline_keyboard: [
      [
        { text: "📊 Full Analytics", callback_data: "adm_stats" },
        { text: "📢 Broadcast Center", callback_data: "adm_broadcast_menu" },
      ],
      [
        { text: `📩 Requests (${pendingRequests?.c || 0})`, callback_data: "adm_requests" },
        { text: `💳 VIP Slips (${pendingSlips?.c || 0})`, callback_data: "adm_slips" },
      ],
      [
        { text: `📦 Queue & Add (${queueCount})`, callback_data: "adm_queue" },
        { text: "🚫 Ban Manager", callback_data: "adm_ban_menu" },
      ],
      [
        { text: "⚙️ System Configuration", callback_data: "adm_config" },
        { text: "🔄 Refresh", callback_data: "adm_refresh" },
      ],
      [
        { text: "❌ Close Panel", callback_data: "adm_close" },
      ],
    ],
  };

  if (editCb) {
    await editTelegramMessage(env, editCb, text, kb);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: editCb.id, text: "🔄 Panel Updated!" });
  } else {
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: text,
      reply_markup: kb,
    });
  }
}

async function handleAdminPanelCallback(cb, env) {
  const chatId = cb.from.id.toString();
  const data = cb.data || "";

  if (!isAuthorizedAdmin(chatId, env)) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⛔ Access Denied! Owner Only.",
      show_alert: true,
    });
    return;
  }

  if (data === "adm_panel" || data === "adm_refresh") {
    await sendAdminDashboard(env, chatId, cb);
    return;
  }

  if (data === "adm_close") {
    await editTelegramMessage(env, cb, "🔒 <b>Admin Control Panel Closed.</b>\nType <code>/admin</code> anytime to reopen.", { inline_keyboard: [] });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_stats") {
    const totalUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE user_id NOT LIKE 'admin_%'`).first();
    const activeVip = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(Date.now()).first();
    const bannedUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_banned = 1`).first();
    const totalBatches = await env.DB.prepare(`SELECT COUNT(*) as c FROM batches`).first();
    const queueSize = await env.DB.prepare(`SELECT COUNT(*) as c FROM deletions`).first();
    const pendingSlips = await env.DB.prepare(`SELECT COUNT(*) as c FROM vip_requests WHERE status = 'pending'`).first();
    const pendingRequests = await env.DB.prepare(`SELECT COUNT(*) as c FROM requests WHERE status = 'pending'`).first();
    const todayDownloads = await env.DB.prepare(`SELECT SUM(daily_downloads) as total FROM users WHERE daily_downloads > 0`).first();

    const text = `📊 <b>PixelPop Real-Time Analytics:</b>\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Total Users:</b> ${totalUsers?.c || 0}\n👑 <b>Active VIPs:</b> ${activeVip?.c || 0}\n🚫 <b>Banned Users:</b> ${bannedUsers?.c || 0}\n📥 <b>Today's Downloads:</b> ${todayDownloads?.total || 0}\n💳 <b>Pending Slips:</b> ${pendingSlips?.c || 0}\n🎬 <b>Pending Requests:</b> ${pendingRequests?.c || 0}\n📦 <b>Stored Batches:</b> ${totalBatches?.c || 0}\n🗑️ <b>Auto-Delete Queue:</b> ${queueSize?.c || 0}\n━━━━━━━━━━━━━━━━━━━━\n<i>Security: Sliding Window Anti-Flood & 15-min Token TTL Active</i>`;

    const kb = {
      inline_keyboard: [
        [{ text: "🔄 Refresh Stats", callback_data: "adm_stats" }, { text: "🔙 Back to Panel", callback_data: "adm_panel" }],
      ],
    };
    await editTelegramMessage(env, cb, text, kb);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_broadcast_menu") {
    const totalUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE user_id NOT LIKE 'admin_%' AND is_banned = 0`).first();
    const activeVip = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(Date.now()).first();
    const freeUsers = (totalUsers?.c || 0) - (activeVip?.c || 0);

    const text = `📢 <b>PixelPop Broadcast & Messaging Center:</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබට කැමති පරිදි සියලු දෙනාට, Paid (VIP) අයට හෝ තනි User කෙනෙකුට පණිවිඩ යැවිය හැක:\n\n1️⃣ <b>සියලුම Users ලාට (${totalUsers?.c || 0}):</b>\n<code>/broadcast Your message</code>\n\n2️⃣ <b>Paid / VIP අයට පමණක් (${activeVip?.c || 0}):</b>\n<code>/broadcast_vip Your message</code>\n\n3️⃣ <b>Free Users ලාට පමණක් (${freeUsers > 0 ? freeUsers : 0}):</b>\n<code>/broadcast_free Your message</code>\n\n4️⃣ <b>තනි User කෙනෙකුට යැවීමට (Direct Message):</b>\n<code>/msg &lt;USER_ID&gt; Your message</code>\n━━━━━━━━━━━━━━━━━━━━\n💡 <i>ඕනෑම Message / Photo / Video එකකට Reply කරද ඉහත Commands යැවිය හැක (Forward/Copy Support)!</i>`;

    const kb = {
      inline_keyboard: [
        [{ text: `👑 List Paid Users (${activeVip?.c || 0})`, callback_data: "adm_list_paid" }],
        [{ text: "🔙 Back to Panel", callback_data: "adm_panel" }],
      ],
    };
    await editTelegramMessage(env, cb, text, kb);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_list_paid") {
    const now = Date.now();
    let vipUsers = [];
    try {
      const res = await env.DB.prepare(`
        SELECT user_id, username, first_name, vip_until 
        FROM users 
        WHERE is_vip = 1 AND vip_until > ? 
        ORDER BY vip_until ASC 
        LIMIT 10
      `).bind(now).all();
      vipUsers = res?.results || [];
    } catch {}

    if (vipUsers.length === 0) {
      const text = `👑 <b>No Active Paid Users!</b>\n━━━━━━━━━━━━━━━━━━━━\nමේ මොහොතේ Active VIP සාමාජිකයින් කිසිවෙකු නොමැත.`;
      const kb = {
        inline_keyboard: [[{ text: "🔙 Back to Broadcast Menu", callback_data: "adm_broadcast_menu" }]],
      };
      await editTelegramMessage(env, cb, text, kb);
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    let text = `👑 <b>Active Paid (VIP) Members (${vipUsers.length}):</b>\n━━━━━━━━━━━━━━━━━━━━\nඔබට පහතින් Paid User කෙනෙකු තෝරාගෙන <code>/msg &lt;ID&gt; &lt;Text&gt;</code> මගින් කෙළින්ම පණිවිඩයක් යැවිය හැක:\n\n`;

    for (let i = 0; i < vipUsers.length; i++) {
      const u = vipUsers[i];
      const name = escapeHtml(u.first_name || u.username || "User");
      const uname = u.username ? ` (@${u.username})` : "";
      const remainingDays = Math.max(1, Math.ceil((u.vip_until - now) / (24 * 60 * 60 * 1000)));

      text += `${i + 1}. 👤 <b>${name}</b>${uname}\n   🆔 ID: <code>${u.user_id}</code>\n   ⏳ ඉතිරි කාලය: <b>${remainingDays} days</b>\n   💬 Message: <code>/msg ${u.user_id} Hello!</code>\n\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━\n<i>ID එක Tap කර Copy කරගෙන <code>/msg ID Message</code> ලෙස යවන්න.</i>`;

    const kb = {
      inline_keyboard: [
        [{ text: "🔙 Back to Broadcast Menu", callback_data: "adm_broadcast_menu" }],
        [{ text: "🏠 Main Admin Panel", callback_data: "adm_panel" }],
      ],
    };
    await editTelegramMessage(env, cb, text, kb);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_requests") {
    let reqs = [];
    try {
      const res = await env.DB.prepare(`SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`).all();
      reqs = res?.results || [];
    } catch {}

    if (reqs.length === 0) {
      const text = `🎉 <b>No Pending Requests!</b>\n━━━━━━━━━━━━━━━━━━━━\nමේ මොහොතේ Users ලාගෙන් ලැබුණු නොවිසඳුණු Movie / Series ඉල්ලීම් නොමැත.`;
      const kb = {
        inline_keyboard: [[{ text: "🔙 Back to Panel", callback_data: "adm_panel" }]],
      };
      await editTelegramMessage(env, cb, text, kb);
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    let text = `📩 <b>Pending Movie Requests (${reqs.length}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    const buttons = [];
    for (const r of reqs) {
      text += `🎬 <b>#${r.id}:</b> ${escapeHtml(r.query)} (By: ${escapeHtml(r.user_name || String(r.user_id))})\n`;
      buttons.push([
        { text: `✅ Uploaded #${r.id}`, callback_data: `req_fulfill_${r.id}` },
        { text: `❌ Decline #${r.id}`, callback_data: `req_decline_${r.id}` },
      ]);
    }
    buttons.push([{ text: "🔙 Back to Panel", callback_data: "adm_panel" }]);

    await editTelegramMessage(env, cb, text, { inline_keyboard: buttons });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_slips") {
    let slips = [];
    try {
      const res = await env.DB.prepare(`SELECT * FROM vip_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`).all();
      slips = res?.results || [];
    } catch {}

    if (slips.length === 0) {
      const text = `🎉 <b>No Pending VIP Slips!</b>\n━━━━━━━━━━━━━━━━━━━━\nමේ මොහොතේ Approve කිරීමට කිසිදු Bank Receipt එකක් නොමැත.`;
      const kb = {
        inline_keyboard: [[{ text: "🔙 Back to Panel", callback_data: "adm_panel" }]],
      };
      await editTelegramMessage(env, cb, text, kb);
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    let text = `💳 <b>Pending Bank Slips (${slips.length}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    const buttons = [];
    for (const s of slips) {
      text += `🧾 <b>#${s.id}:</b> User <code>${s.user_id}</code>\n`;
      buttons.push([
        { text: `🗓️ Weekly #${s.id}`, callback_data: `vip_approve_weekly_${s.id}` },
        { text: `👑 Monthly #${s.id}`, callback_data: `vip_approve_monthly_${s.id}` },
        { text: `🌟 Lifetime #${s.id}`, callback_data: `vip_approve_lifetime_${s.id}` },
      ]);
      buttons.push([
        { text: `❌ Reject #${s.id}`, callback_data: `vip_reject_${s.id}` },
      ]);
    }
    buttons.push([{ text: "🔙 Back to Panel", callback_data: "adm_panel" }]);

    await editTelegramMessage(env, cb, text, { inline_keyboard: buttons });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_queue") {
    let batchRes;
    try {
      batchRes = await env.DB.prepare(`SELECT message_id FROM admin_batch WHERE admin_id = ? ORDER BY id ASC`).bind(chatId).all();
    } catch {
      batchRes = await env.DB.prepare(`SELECT message_id FROM admin_batch ORDER BY id ASC`).all();
    }
    const batch = (batchRes?.results || []).map((r) => r.message_id);

    let draftTitle = "PixelPop Release";
    try {
      const draft = await env.DB.prepare(`SELECT msg_ids FROM users WHERE user_id = 'admin_title_draft'`).first();
      if (draft?.msg_ids) draftTitle = draft.msg_ids;
    } catch {}

    const text = `📦 <b>Admin Upload Queue:</b>\n━━━━━━━━━━━━━━━━━━━━\n📁 <b>Files in Queue:</b> <b>${batch.length}</b>\n🏷️ <b>Draft Title:</b> <i>${escapeHtml(draftTitle)}</i>\n\n💡 <b>ක්‍රියා පටිපාටිය:</b>\n1. <code>/add Title</code> යවන්න.\n2. Files මෙහි forward කරන්න.\n3. අවසානයේ <b>'⚡ Generate Links'</b> ඔබන්න.`;

    const buttons = [];
    if (batch.length > 0) {
      buttons.push([
        { text: "⚡ Generate Links (/done)", callback_data: "admin_done" },
        { text: "🗑️ Clear Queue (/cancel)", callback_data: "admin_cancel" },
      ]);
    }
    buttons.push([{ text: "🔙 Back to Panel", callback_data: "adm_panel" }]);

    await editTelegramMessage(env, cb, text, { inline_keyboard: buttons });
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_ban_menu") {
    const bannedRes = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_banned = 1`).first();
    const text = `🚫 <b>PixelPop User Ban Manager:</b>\n━━━━━━━━━━━━━━━━━━━━\n🚫 <b>Currently Banned Users:</b> <b>${bannedRes?.c || 0}</b>\n\n🛠️ <b>Commands:</b>\n• <b>Ban User:</b> <code>/ban &lt;user_id&gt; [Reason]</code>\n• <b>Unban User:</b> <code>/unban &lt;user_id&gt;</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>Banned users cannot download files, search, or request titles.</i>`;

    const kb = {
      inline_keyboard: [
        [{ text: "🔙 Back to Panel", callback_data: "adm_panel" }],
      ],
    };
    await editTelegramMessage(env, cb, text, kb);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (data === "adm_config") {
    const coAdmins = env.CO_ADMINS ? env.CO_ADMINS : "None (Strictly Single Owner 🔒)";
    const text = `⚙️ <b>PixelPop System Configuration:</b>\n━━━━━━━━━━━━━━━━━━━━\n👑 <b>Primary Owner ID:</b> <code>${env.ADMIN_ID || "Not set"}</code>\n🛡️ <b>Co-Admins:</b> <code>${coAdmins}</code>\n🤖 <b>Backup Bot:</b> @${env.BACKUP_BOT_USERNAME || "Not set"}\n📢 <b>Force-Sub Channel:</b> ${env.FORCE_SUB_CHANNEL_LINK || "Not set"}\n📁 <b>Storage Channel ID:</b> <code>${env.STORAGE_CHANNEL_ID || "Not set"}</code>\n⚡ <b>Free Daily Limit:</b> Unlimited (0)\n━━━━━━━━━━━━━━━━━━━━\n<i>ඔබේ Owner ID එකට පමණක් Admin Panel එක විවෘත වේ.</i>`;

    const kb = {
      inline_keyboard: [
        [{ text: "🔙 Back to Panel", callback_data: "adm_panel" }],
      ],
    };
    await editTelegramMessage(env, cb, text, kb);
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
}

async function handleAdminStats(env, chatId) {
  const totalUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE user_id NOT LIKE 'admin_%'`).first();
  const activeVip = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_vip = 1 AND vip_until > ?`).bind(Date.now()).first();
  const bannedUsers = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_banned = 1`).first();
  const totalBatches = await env.DB.prepare(`SELECT COUNT(*) as c FROM batches`).first();
  const queueSize = await env.DB.prepare(`SELECT COUNT(*) as c FROM deletions`).first();
  const pendingSlips = await env.DB.prepare(`SELECT COUNT(*) as c FROM vip_requests WHERE status = 'pending'`).first();
  const pendingRequests = await env.DB.prepare(`SELECT COUNT(*) as c FROM requests WHERE status = 'pending'`).first();
  const todayDownloads = await env.DB.prepare(`SELECT SUM(daily_downloads) as total FROM users WHERE daily_downloads > 0`).first();

  const text = `📊 <b>PixelPop Enterprise Dashboard:</b>\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Total Users:</b> ${totalUsers?.c || 0}\n👑 <b>Active VIPs:</b> ${activeVip?.c || 0}\n🚫 <b>Banned Users:</b> ${bannedUsers?.c || 0}\n📥 <b>Today's Downloads:</b> ${todayDownloads?.total || 0}\n💳 <b>Pending Slips:</b> ${pendingSlips?.c || 0}\n🎬 <b>Pending Requests:</b> ${pendingRequests?.c || 0}\n📦 <b>Stored Batches:</b> ${totalBatches?.c || 0}\n🗑️ <b>Auto-Delete Queue:</b> ${queueSize?.c || 0}\n━━━━━━━━━━━━━━━━━━━━\n<i>Security: Sliding Window Anti-Flood & 15-min Token TTL Active</i>`;

  await sendReply(env, chatId, text);
}

async function handleBroadcast(env, chatId, broadcastPayload, targetGroup = "all", isCopy = false) {
  let query = `SELECT user_id FROM users WHERE user_id NOT LIKE 'admin_%' AND is_banned = 0`;
  let binds = [];

  const now = Date.now();
  if (targetGroup === "vip") {
    query += ` AND is_vip = 1 AND vip_until > ?`;
    binds.push(now);
  } else if (targetGroup === "free") {
    query += ` AND (is_vip = 0 OR vip_until <= ?)`;
    binds.push(now);
  }
  query += ` LIMIT 2000`;

  let usersRes;
  if (binds.length > 0) {
    usersRes = await env.DB.prepare(query).bind(...binds).all();
  } else {
    usersRes = await env.DB.prepare(query).all();
  }
  const users = usersRes?.results || [];

  const groupLabel = targetGroup.toUpperCase();
  if (users.length === 0) {
    await sendReply(env, chatId, `⚠️ [${groupLabel}] category එකේ කිසිදු user කෙනෙක් හමු නොවීය!`);
    return;
  }

  await sendReply(env, chatId, `🚀 Starting [${groupLabel}] broadcast to ${users.length} users...`);

  let count = 0;
  let failed = 0;
  for (const u of users) {
    let res;
    if (isCopy) {
      res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
        chat_id: u.user_id,
        from_chat_id: chatId,
        message_id: broadcastPayload,
      });
    } else {
      res = await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: u.user_id,
        parse_mode: "HTML",
        text: broadcastPayload,
      });
    }

    if (res?.ok) {
      count++;
    } else {
      failed++;
    }
  }

  await sendReply(
    env,
    chatId,
    `✅ <b>[${groupLabel}] Broadcast Complete!</b>\n━━━━━━━━━━━━━━━━━━━━\n🎯 Targeted: ${users.length}\n📬 Successfully Delivered: ${count}\n⚠️ Failed / Blocked: ${failed}`
  );
}

async function handleDirectMessage(env, adminChatId, targetUserId, textContent, replyMsgId = null) {
  let res;
  if (replyMsgId) {
    res = await callTelegram(env.BOT_TOKEN, "copyMessage", {
      chat_id: targetUserId,
      from_chat_id: adminChatId,
      message_id: replyMsgId,
    });
  } else {
    res = await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: targetUserId,
      parse_mode: "HTML",
      text: `💬 <b>Message from PixelPop Admin:</b>\n━━━━━━━━━━━━━━━━━━━━\n${textContent}\n━━━━━━━━━━━━━━━━━━━━`,
    });
  }

  if (res?.ok) {
    await sendReply(env, adminChatId, `✅ <b>Message Sent!</b>\nUser <code>${targetUserId}</code> වෙත පණිවිඩය සාර්ථකව භාර දෙන ලදී.`);
  } else {
    await sendReply(env, adminChatId, `❌ <b>Failed to deliver message:</b> ${res?.description || "User may have blocked the bot or invalid ID."}`);
  }
}

// ================= TELEGRAM INLINE QUERY SEARCH =================
async function handleInlineQuery(iq, env) {
  if (!iq || !iq.id) return;
  const rawQuery = (iq.query || "").trim();
  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";

  let batches = [];
  try {
    if (rawQuery.length > 0) {
      const searchPattern = `%${rawQuery}%`;
      const res = await env.DB.prepare(`
        SELECT token, title, poster_url, created_at FROM batches
        WHERE title LIKE ?
        ORDER BY created_at DESC
        LIMIT 25
      `).bind(searchPattern).all();
      batches = res?.results || [];
    } else {
      // Recent releases when query is empty
      const res = await env.DB.prepare(`
        SELECT token, title, poster_url, created_at FROM batches
        ORDER BY created_at DESC
        LIMIT 15
      `).all();
      batches = res?.results || [];
    }
  } catch (err) {
    console.error("Inline query DB error:", err);
  }

  const results = [];

  for (const b of batches) {
    const title = b.title || "Movie / Series Pack";
    const startUrl = `https://t.me/${botUsername}?start=${b.token}`;
    const thumbUrl = b.poster_url || "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=300&q=80";

    results.push({
      type: "article",
      id: `batch_${b.token}`,
      title: title,
      description: "🎬 Tap to send link and download instantly via PixelPop Bot",
      thumb_url: thumbUrl,
      input_message_content: {
        message_text: `🎬 <b>${escapeHtml(title)}</b>\n\n📥 <b>Download & Stream:</b>\n<a href="${startUrl}">👉 Click here to access files</a>\n\n<i>Powered by PixelPop Media Bot</i>`,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Download Now / ලබාගන්න", url: startUrl },
          ],
        ],
      },
    });
  }

  // If no results found and user typed something, show a request card
  if (results.length === 0 && rawQuery.length > 0) {
    results.push({
      type: "article",
      id: "no_results_found",
      title: `🔍 No results for "${rawQuery}"`,
      description: `Tap to request "${rawQuery}" from PixelPop Bot admins`,
      input_message_content: {
        message_text: `🔍 <b>Movie Not Found:</b> "${escapeHtml(rawQuery)}"\n\n💡 You can request this title by sending:\n<code>/request ${escapeHtml(rawQuery)}</code>\n\nto @${botUsername}!`,
        parse_mode: "HTML",
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎬 Request this Movie", url: `https://t.me/${botUsername}?start=req_${encodeURIComponent(rawQuery.slice(0, 30))}` },
          ],
        ],
      },
    });
  }

  await callTelegram(env.BOT_TOKEN, "answerInlineQuery", {
    inline_query_id: iq.id,
    results: results.slice(0, 25),
    cache_time: 30,
    is_personal: false,
  });
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

// ================= SERIES & EPISODE BROWSER & LIVE SEARCH =================
function parseQuality(title) {
  if (!title) return { raw: "HD", badge: "🎬 HD Quality", weight: 2 };
  const str = title.toLowerCase();

  if (/\b(4k|2160p|uhd|ultra[\s.-]?hd)\b/i.test(str)) {
    return { raw: "4K", badge: "🌟 4K Ultra HD", weight: 4 };
  }
  if (/\b(1080p|fhd|full[\s.-]?hd)\b/i.test(str)) {
    return { raw: "1080p", badge: "🖥️ 1080p Full HD", weight: 3 };
  }
  if (/\b(720p|hd)\b/i.test(str)) {
    return { raw: "720p", badge: "💻 720p HD", weight: 2 };
  }
  if (/\b(480p|360p|sd)\b/i.test(str)) {
    return { raw: "480p", badge: "📱 480p SD", weight: 1 };
  }
  return { raw: "HD", badge: "🎬 Standard HD", weight: 2 };
}

function cleanMovieRootTitle(rawTitle) {
  if (!rawTitle) return "Untitled";
  return rawTitle
    .replace(/[\[\(].*?(1080p|720p|480p|4k|2160p|uhd|fhd|hdr|bluray|web-dl|hdrip|x264|x265|hevc|dual|audio|sinhala).*?[\]\)]/gi, "")
    .replace(/\b(1080p|720p|480p|4k|2160p|uhd|fhd|hdr|bluray|web-dl|webrip|hdrip|dvdrip|remux|x264|x265|hevc|6ch|dual[\s.-]?audio|sinhala[\s.-]?sub)\b/gi, "")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseExtraBadges(title) {
  if (!title) return "";
  const str = title.toLowerCase();
  const badges = [];
  if (/\b(sinhala[\s.-]?sub|subtitles?|සබ්)\b/i.test(str)) {
    badges.push("🇱🇰 Sub");
  }
  if (/\b(dual[\s.-]?audio|multi[\s.-]?audio)\b/i.test(str)) {
    badges.push("🎙️ Dual");
  }
  if (/\b(bluray|bdrip)\b/i.test(str)) {
    badges.push("💿 BluRay");
  } else if (/\b(web[\s.-]?dl|webrip)\b/i.test(str)) {
    badges.push("🌐 WEB-DL");
  }
  return badges.length > 0 ? ` [${badges.join(" | ")}]` : "";
}

function getTrailerUrl(title) {
  const clean = cleanMovieRootTitle(title);
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(clean + " official trailer")}`;
}

function parseMediaTitle(rawTitle) {
  if (!rawTitle) return { isSeries: false, cleanTitle: "Untitled" };

  let title = rawTitle
    .replace(/[\[\(].*?(1080p|720p|480p|4k|hdr|bluray|web-dl|hdrip|x264|x265|hevc).*?[\]\)]/gi, "")
    .replace(/\b(1080p|720p|480p|4k|hdr|bluray|web-dl|hdrip|x264|x265|hevc)\b/gi, "")
    .trim();

  // Pattern 1: Complete Season Pack (e.g. "Title (Complete Season Pack)" or "Title Season 2 (Complete Season Pack)")
  const packPattern = title.match(/^(.*?)(?:\s+(?:season|s)\s*0*(\d+))?\s*(?:\(|\[)?\s*complete\s*season\s*pack\s*(?:\)|\])?$/i);
  if (packPattern) {
    const seriesName = cleanSeriesName(packPattern[1]);
    const season = packPattern[2] ? parseInt(packPattern[2], 10) : 1;
    return {
      isSeries: true,
      isPack: true,
      seriesName,
      season,
      episode: 0,
      cleanTitle: `${seriesName} Season ${season} (Complete Pack)`
    };
  }

  // Pattern 2: S01E02 or S1 E2 or S01-E02
  const sPattern = title.match(/^(.*?)[.\s_-]+(?:s|season)\s*0*(\d+)[.\s_-]*(?:e|ep|episode)\s*0*(\d+)(.*)$/i);
  if (sPattern) {
    const seriesName = cleanSeriesName(sPattern[1]);
    const season = parseInt(sPattern[2], 10);
    const episode = parseInt(sPattern[3], 10);
    return {
      isSeries: true,
      seriesName,
      season,
      episode,
      cleanTitle: `${seriesName} S${season < 10 ? "0" + season : season}E${episode < 10 ? "0" + episode : episode}`
    };
  }

  // Pattern 3: Title - Episode 1 or Title Episode 01
  const epPattern = title.match(/^(.*?)(?:\s*-\s*|\s+)(?:episode|ep)\s*0*(\d+)(.*)$/i);
  if (epPattern) {
    let seriesName = cleanSeriesName(epPattern[1]);
    let season = 1;
    const sInName = seriesName.match(/^(.*?)\s+(?:season|s)\s*0*(\d+)$/i);
    if (sInName) {
      seriesName = cleanSeriesName(sInName[1]);
      season = parseInt(sInName[2], 10);
    }
    const episode = parseInt(epPattern[2], 10);
    return {
      isSeries: true,
      seriesName,
      season,
      episode,
      cleanTitle: `${seriesName} S${season < 10 ? "0" + season : season}E${episode < 10 ? "0" + episode : episode}`
    };
  }

  // Pattern 4: Season only (e.g. "Title Season 1" or "Title S02")
  const seasonOnlyPattern = title.match(/^(.*?)\s+(?:season|s)\s*0*(\d+)$/i);
  if (seasonOnlyPattern) {
    const seriesName = cleanSeriesName(seasonOnlyPattern[1]);
    const season = parseInt(seasonOnlyPattern[2], 10);
    return {
      isSeries: true,
      seriesName,
      season,
      episode: 0,
      cleanTitle: `${seriesName} Season ${season}`
    };
  }

  return {
    isSeries: false,
    cleanTitle: cleanSeriesName(title)
  };
}

function cleanSeriesName(name) {
  return (name || "")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function editTelegramMessage(env, cb, textOrCaption, replyMarkup) {
  const msg = cb.message;
  if (!msg) return;
  const chatId = msg.chat.id.toString();
  const messageId = msg.message_id;

  if (msg.photo && msg.photo.length > 0) {
    const res = await callTelegram(env.BOT_TOKEN, "editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: textOrCaption,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
    if (res?.ok) return;
  }

  await callTelegram(env.BOT_TOKEN, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: textOrCaption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

async function sendSearchReply(env, chatId, poster, textOrCaption, inlineKeyboard, replyToMsgId = null) {
  const keyboardObj = Array.isArray(inlineKeyboard) ? { inline_keyboard: inlineKeyboard } : inlineKeyboard;

  if (poster && textOrCaption.length <= 950) {
    const payload = {
      chat_id: chatId,
      photo: poster,
      caption: textOrCaption,
      parse_mode: "HTML",
      reply_markup: keyboardObj,
    };
    if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
    const photoRes = await callTelegram(env.BOT_TOKEN, "sendPhoto", payload);
    if (photoRes?.ok) return photoRes;
  }

  const payload = {
    chat_id: chatId,
    text: textOrCaption,
    parse_mode: "HTML",
    reply_markup: keyboardObj,
  };
  if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
  return callTelegram(env.BOT_TOKEN, "sendMessage", payload);
}

// 🔀 Tab Switcher for Movies vs TV Series
async function handleSwitchTab(env, cb, token, targetTab) {
  const root = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(token).first();
  const rawSearch = cleanMovieRootTitle(root?.title || "");
  const isGroup = cb.message?.chat?.type === "group" || cb.message?.chat?.type === "supergroup";
  await handleLiveSearch(env, cb.message.chat.id.toString(), rawSearch, cb.message.message_id, isGroup, false, targetTab, cb);
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 🎬 Browse Movie Qualities (720p / 1080p / 4K)
async function handleBrowseMovieQuality(env, cb, token) {
  const root = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(token).first();
  if (!root) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⚠️ Movie not found in database!",
      show_alert: true,
    });
    return;
  }

  const rootTitle = cleanMovieRootTitle(root.title);

  let variants = [];
  try {
    const res = await env.DB.prepare(`
      SELECT * FROM batches 
      WHERE title LIKE ? OR token = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(`%${rootTitle}%`, token).all();
    variants = res?.results || [root];
  } catch {
    variants = [root];
  }

  // Deduplicate by quality
  const qualMap = new Map();
  for (const v of variants) {
    const q = parseQuality(v.title);
    if (!qualMap.has(q.raw) || (v.poster_url && !qualMap.get(q.raw).poster_url)) {
      qualMap.set(q.raw, { ...v, qualObj: q });
    }
  }

  const sortedVariants = Array.from(qualMap.values()).sort((a, b) => b.qualObj.weight - a.qualObj.weight);

  // If only 1 quality exists, show download confirmation directly!
  if (sortedVariants.length <= 1) {
    await handleConfirmMovieDownload(env, cb, token, token);
    return;
  }

  // Multiple qualities -> Show Quality Selection Screen
  const tmdb = await fetchTmdbInfo(env, rootTitle);
  const trailerUrl = tmdb?.trailer || getTrailerUrl(rootTitle);
  const yearStr = tmdb?.year ? ` (${tmdb.year})` : "";
  const ratingStr = tmdb?.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
  const overviewStr = tmdb?.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n` : "";

  const caption = `🎬 <b>${escapeHtml(rootTitle)}</b>${yearStr}\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}━━━━━━━━━━━━━━━━━━━━\n✨ <b>Select Video Quality / කොලිටිය තෝරන්න:</b> 😊👇\n\nඔබට අවශ්‍ය Video Quality එක පහතින් තෝරන්න:`;

  const qualButtons = sortedVariants.map((v) => [
    { text: `${v.qualObj.badge}${parseExtraBadges(v.title)}`, callback_data: `br_mq_${v.token}_${token}` },
  ]);

  qualButtons.push([
    { text: "▶️ Watch Trailer / ට්‍රේලර් බලන්න", url: trailerUrl },
  ]);

  qualButtons.push([
    { text: "↩️ Back to Movies / ආපසු", callback_data: `br_tab_mov_${token}` },
  ]);

  await editTelegramMessage(env, cb, caption, { inline_keyboard: qualButtons });
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 📥 Confirm Movie Download Card
async function handleConfirmMovieDownload(env, cb, chosenToken, rootToken) {
  const batch = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(chosenToken).first();
  if (!batch) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⚠️ File not found!",
      show_alert: true,
    });
    return;
  }

  const rootTitle = cleanMovieRootTitle(batch.title);
  const qualObj = parseQuality(batch.title);
  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";
  const startUrl = `https://t.me/${botUsername}?start=${chosenToken}`;
  const tmdb = await fetchTmdbInfo(env, rootTitle);
  const trailerUrl = tmdb?.trailer || getTrailerUrl(rootTitle);
  const yearStr = tmdb?.year ? ` (${tmdb.year})` : "";
  const extraBadges = parseExtraBadges(batch.title);

  const caption = `🎬 <b>${escapeHtml(rootTitle)}</b>${yearStr} [${qualObj.raw}${extraBadges}]\n━━━━━━━━━━━━━━━━━━━━\n📥 <b>File Ready for Download!</b>\n\n👉 පහත <b>'⚡ Download ⚡'</b> Button එක ඔබන්න.\n👉 එවිට Bot Private Chat එක Open වේ. එතන Ad එක නරඹා File එක ලබාගන්න.\n━━━━━━━━━━━━━━━━━━━━\n<i>🛡️ Content Protected: Permanent Storage</i>`;

  const kb = {
    inline_keyboard: [
      [{ text: `⚡ Download (${qualObj.raw}) ⚡`, url: startUrl }],
      [{ text: "▶️ Watch Trailer / ට්‍රේලර් බලන්න", url: trailerUrl }],
      [{ text: "↩️ Back to Qualities / ආපසු", callback_data: `br_mov_${rootToken}` }],
      [{ text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" }],
    ],
  };

  await editTelegramMessage(env, cb, caption, kb);
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 📺 Series Seasons Browser
async function handleBrowseSeriesSeasons(env, cb, token) {
  const root = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(token).first();
  if (!root) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⚠️ Series not found in database!",
      show_alert: true,
    });
    return;
  }

  const meta = parseMediaTitle(root.title);
  const seriesName = root.series_name || meta.seriesName || root.title;

  let allBatches = [];
  try {
    const res = await env.DB.prepare(`
      SELECT * FROM batches 
      WHERE series_name = ? OR title LIKE ?
      ORDER BY season ASC, episode ASC
    `).bind(seriesName, `%${seriesName}%`).all();
    allBatches = res?.results || [];
  } catch {
    allBatches = [root];
  }

  if (allBatches.length === 0) allBatches = [root];

  const seasonsSet = new Set();
  for (const b of allBatches) {
    const bMeta = parseMediaTitle(b.title);
    const s = b.season || bMeta.season || 1;
    seasonsSet.add(s);
  }
  const seasons = Array.from(seasonsSet).sort((a, b) => a - b);

  const seasonButtons = [];
  for (let i = 0; i < seasons.length; i += 2) {
    const row = [];
    const s1 = seasons[i];
    row.push({ text: `🌟 Season ${s1}`, callback_data: `br_sea_${token}_${s1}` });
    if (i + 1 < seasons.length) {
      const s2 = seasons[i + 1];
      row.push({ text: `🌟 Season ${s2}`, callback_data: `br_sea_${token}_${s2}` });
    }
    seasonButtons.push(row);
  }

  seasonButtons.push([
    { text: "↩️ Back to Series List / ආපසු", callback_data: `br_tab_ser_${token}` },
  ]);

  seasonButtons.push([
    { text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" },
  ]);

  const caption = `📺 <b>${escapeHtml(seriesName)}</b>\n━━━━━━━━━━━━━━━━━━━━\n🗓️ <b>Select Season / සීසන් එක තෝරන්න:</b> (${seasons.length} Seasons available)\n\n👇 පහත Buttons වලින් ඔබ නැරඹීමට කැමති Season එක තෝරන්න:`;

  await editTelegramMessage(env, cb, caption, { inline_keyboard: seasonButtons });
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 🍿 Series Episodes Browser
async function handleBrowseSeasonEpisodes(env, cb, token, seasonNum) {
  const root = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(token).first();
  const meta = parseMediaTitle(root?.title);
  const seriesName = root?.series_name || meta.seriesName || root?.title || "TV Series";

  let all = [];
  try {
    const res = await env.DB.prepare(`
      SELECT * FROM batches 
      WHERE series_name = ? OR title LIKE ?
      ORDER BY episode ASC, created_at ASC
    `).bind(seriesName, `%${seriesName}%`).all();
    all = res?.results || [];
  } catch {
    all = root ? [root] : [];
  }

  let episodesMap = new Map(); // epNum -> [variants]
  let packToken = null;

  for (const b of all) {
    const bMeta = parseMediaTitle(b.title);
    const s = b.season || bMeta.season || 1;
    if (s === seasonNum) {
      if (bMeta.isPack || b.episode === 0) {
        packToken = b.token;
      } else {
        const epNum = b.episode || bMeta.episode || 1;
        if (!episodesMap.has(epNum)) {
          episodesMap.set(epNum, []);
        }
        episodesMap.get(epNum).push(b);
      }
    }
  }

  const epNums = Array.from(episodesMap.keys()).sort((a, b) => a - b);
  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";
  const epButtons = [];

  for (let i = 0; i < epNums.length; i += 3) {
    const row = [];
    for (let j = i; j < Math.min(i + 3, epNums.length); j++) {
      const epNum = epNums[j];
      const epStr = epNum < 10 ? `0${epNum}` : `${epNum}`;
      const firstEpBatch = episodesMap.get(epNum)[0];
      row.push({
        text: `🎬 Ep ${epStr}`,
        callback_data: `br_ep_${firstEpBatch.token}_${token}_${seasonNum}`,
      });
    }
    epButtons.push(row);
  }

  if (packToken) {
    epButtons.push([
      { text: `👑 Complete Season ${seasonNum} (VIP Pack)`, url: `https://t.me/${botUsername}?start=${packToken}` },
    ]);
  }

  epButtons.push([
    { text: "↩️ Back to Seasons / ආපසු", callback_data: `br_ser_${token}` },
  ]);

  const caption = `📺 <b>${escapeHtml(seriesName)} - Season ${seasonNum}</b>\n━━━━━━━━━━━━━━━━━━━━\n🍿 <b>Select Episode / එපිසෝඩ් එක තෝරන්න:</b> (${epNums.length} Episodes available)\n\n👇 පහතින් ඔබට අවශ්‍ය Episode එක තෝරන්න:`;

  await editTelegramMessage(env, cb, caption, { inline_keyboard: epButtons });
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 🎦 Browse Episode Qualities (720p / 1080p / 4K)
async function handleBrowseEpisodeQuality(env, cb, epToken, parentToken, seasonNum) {
  const epBatch = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(epToken).first();
  if (!epBatch) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⚠️ Episode file not found!",
      show_alert: true,
    });
    return;
  }

  const meta = parseMediaTitle(epBatch.title);
  const seriesName = epBatch.series_name || meta.seriesName || epBatch.title;
  const epNum = epBatch.episode || meta.episode || 1;

  // Search for all quality variants of this episode
  let variants = [];
  try {
    const res = await env.DB.prepare(`
      SELECT * FROM batches 
      WHERE (series_name = ? OR title LIKE ?) AND (season = ? OR title LIKE ?)
      ORDER BY created_at DESC
      LIMIT 20
    `).bind(seriesName, `%${seriesName}%`, seasonNum, `%Season ${seasonNum}%`).all();

    variants = (res?.results || []).filter((b) => {
      const bMeta = parseMediaTitle(b.title);
      const bEp = b.episode || bMeta.episode;
      return bEp === epNum;
    });
  } catch {
    variants = [epBatch];
  }

  if (variants.length === 0) variants = [epBatch];

  // Deduplicate by quality
  const qualMap = new Map();
  for (const v of variants) {
    const q = parseQuality(v.title);
    if (!qualMap.has(q.raw)) {
      qualMap.set(q.raw, { ...v, qualObj: q });
    }
  }

  const sortedVariants = Array.from(qualMap.values()).sort((a, b) => b.qualObj.weight - a.qualObj.weight);

  // If only 1 quality exists, skip quality screen and show download confirmation directly!
  if (sortedVariants.length <= 1) {
    await handleConfirmEpisodeDownload(env, cb, epToken, parentToken, seasonNum);
    return;
  }

  // Multiple qualities -> Show Episode Quality Picker
  const caption = `📺 <b>${escapeHtml(seriesName)} - Season ${seasonNum} Episode ${epNum < 10 ? "0" + epNum : epNum}</b>\n━━━━━━━━━━━━━━━━━━━━\n✨ <b>Select Video Quality / කොලිටිය තෝරන්න:</b> 😊👇\n\nඔබට අවශ්‍ය Video Quality එක පහතින් තෝරන්න:`;

  const qualButtons = sortedVariants.map((v) => [
    { text: `${v.qualObj.badge}${parseExtraBadges(v.title)}`, callback_data: `br_eq_${v.token}_${parentToken}_${seasonNum}` },
  ]);

  qualButtons.push([
    { text: "↩️ Back to Episodes / ආපසු", callback_data: `br_sea_${parentToken}_${seasonNum}` },
  ]);

  await editTelegramMessage(env, cb, caption, { inline_keyboard: qualButtons });
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 📥 Confirm Episode Download Card
async function handleConfirmEpisodeDownload(env, cb, chosenToken, parentToken, seasonNum) {
  const epBatch = await env.DB.prepare(`SELECT * FROM batches WHERE token = ?`).bind(chosenToken).first();
  if (!epBatch) {
    await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "⚠️ Episode file not found!",
      show_alert: true,
    });
    return;
  }

  const qualObj = parseQuality(epBatch.title);
  const extraBadges = parseExtraBadges(epBatch.title);
  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";
  const startUrl = `https://t.me/${botUsername}?start=${chosenToken}`;

  const caption = `🎬 <b>${escapeHtml(epBatch.title)}</b> [${qualObj.raw}${extraBadges}]\n━━━━━━━━━━━━━━━━━━━━\n📥 <b>File Ready for Download!</b>\n\n👉 පහත <b>'⚡ Download Episode ⚡'</b> Button එක ඔබන්න.\n👉 එවිට Bot Private Chat එක Open වේ. එතන Ad එක නරඹා Episode එක ලබාගන්න.\n━━━━━━━━━━━━━━━━━━━━\n<i>🛡️ Content Protected: Permanent Storage</i>`;

  const kb = {
    inline_keyboard: [
      [{ text: `⚡ Download Episode (${qualObj.raw}) ⚡`, url: startUrl }],
      [{ text: "↩️ Back to Episodes / ආපසු", callback_data: `br_sea_${parentToken}_${seasonNum}` }],
      [{ text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" }],
    ],
  };

  await editTelegramMessage(env, cb, caption, kb);
  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
}

// 🔍 Master In-Bot & In-Group Live Search
async function handleLiveSearch(env, chatId, query, replyToMsgId = null, isGroup = false, isExplicitSearch = false, activeTab = null, editCb = null) {
  query = (query || "").trim();
  if (!query || query.length < 2) return;

  const botUsername = env.BOT_USERNAME || "PixelPopStorebot";

  // 1. Search Local Batches in D1
  let batches = [];
  try {
    const searchPattern = `%${query}%`;
    const batchRes = await env.DB.prepare(`
      SELECT * FROM batches 
      WHERE title LIKE ? OR series_name LIKE ?
      ORDER BY created_at DESC 
      LIMIT 80
    `).bind(searchPattern, searchPattern).all();
    batches = batchRes?.results || [];
  } catch (e) {
    try {
      const searchPattern = `%${query}%`;
      const batchRes = await env.DB.prepare(`
        SELECT * FROM batches 
        WHERE title LIKE ?
        ORDER BY created_at DESC 
        LIMIT 80
      `).bind(searchPattern).all();
      batches = batchRes?.results || [];
    } catch (err) {
      console.error("Local search error:", err);
    }
  }

  // 2. Query TMDb for Auto Poster & Synopsis
  const tmdb = await fetchTmdbInfo(env, query);

  // Case A: Batches found in PixelPop database
  if (batches.length > 0) {
    const seriesMap = new Map();
    const movieGroupMap = new Map();

    for (const b of batches) {
      const meta = parseMediaTitle(b.title);
      const sName = b.series_name || (meta.isSeries ? meta.seriesName : null);
      if (sName) {
        const key = sName.toLowerCase().trim();
        if (!seriesMap.has(key)) {
          seriesMap.set(key, {
            name: sName,
            firstToken: b.token,
            poster: b.poster_url,
            seasons: new Set(),
          });
        }
        const sObj = seriesMap.get(key);
        if (!sObj.poster && b.poster_url) sObj.poster = b.poster_url;
        const sNum = b.season || meta.season || 1;
        sObj.seasons.add(sNum);
      } else {
        const rootTitle = cleanMovieRootTitle(b.title);
        const mKey = rootTitle.toLowerCase().trim();
        if (!movieGroupMap.has(mKey)) {
          movieGroupMap.set(mKey, {
            rootTitle,
            firstToken: b.token,
            poster: b.poster_url,
            variants: [],
          });
        }
        const mObj = movieGroupMap.get(mKey);
        if (!mObj.poster && b.poster_url) mObj.poster = b.poster_url;
        mObj.variants.push(b);
      }
    }

    const seriesList = Array.from(seriesMap.values());
    const movieList = Array.from(movieGroupMap.values());

    const hasSeries = seriesList.length > 0;
    const hasMovies = movieList.length > 0;

    // Subcase 1: Exactly 1 TV Series found and 0 movies -> directly show Season selection!
    if (seriesList.length === 1 && !hasMovies) {
      const s = seriesList[0];
      const seasons = Array.from(s.seasons).sort((a, b) => a - b);
      const seasonButtons = [];
      for (let i = 0; i < seasons.length; i += 2) {
        const row = [];
        const s1 = seasons[i];
        row.push({ text: `🌟 Season ${s1}`, callback_data: `br_sea_${s.firstToken}_${s1}` });
        if (i + 1 < seasons.length) {
          const s2 = seasons[i + 1];
          row.push({ text: `🌟 Season ${s2}`, callback_data: `br_sea_${s.firstToken}_${s2}` });
        }
        seasonButtons.push(row);
      }
      seasonButtons.push([
        { text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" },
      ]);

      const poster = s.poster || tmdb?.poster || null;
      const yearStr = tmdb?.year ? ` (${tmdb.year})` : "";
      const ratingStr = tmdb?.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
      const overviewStr = tmdb?.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n━━━━━━━━━━━━━━━━━━━━\n` : "";
      const caption = `📺 <b>${escapeHtml(s.name)}</b>${yearStr}\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}🗓️ <b>Select Season / සීසන් එක තෝරන්න:</b> (${seasons.length} Seasons available)\n\n👇 පහත Buttons වලින් ඔබට අවශ්‍ය Season එක තෝරන්න:`;

      if (editCb) {
        await editTelegramMessage(env, editCb, caption, { inline_keyboard: seasonButtons });
      } else {
        await sendSearchReply(env, chatId, poster, caption, seasonButtons, replyToMsgId);
      }
      return;
    }

    // Subcase 2: Exactly 1 Movie found and 0 series -> directly show Movie Quality selection!
    if (movieList.length === 1 && !hasSeries) {
      const m = movieList[0];
      // Check if multiple qualities exist for this movie
      const qualMap = new Map();
      for (const v of m.variants) {
        const q = parseQuality(v.title);
        if (!qualMap.has(q.raw)) qualMap.set(q.raw, { ...v, qualObj: q });
      }
      const sortedVariants = Array.from(qualMap.values()).sort((a, b) => b.qualObj.weight - a.qualObj.weight);

      const trailerUrl = tmdb?.trailer || getTrailerUrl(m.rootTitle);
      const poster = tmdb?.poster || m.poster || null;
      const yearStr = tmdb?.year ? ` (${tmdb.year})` : "";
      const ratingStr = tmdb?.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
      const overviewStr = tmdb?.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n` : "";

      if (sortedVariants.length > 1) {
        // Multiple qualities -> Quality Picker
        const caption = `🎬 <b>${escapeHtml(m.rootTitle)}</b>${yearStr}\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}━━━━━━━━━━━━━━━━━━━━\n✨ <b>Select Video Quality / කොලිටිය තෝරන්න:</b> 😊👇\n\nඔබට අවශ්‍ය Video Quality එක පහතින් තෝරන්න:`;
        const qualButtons = sortedVariants.map((v) => [
          { text: `${v.qualObj.badge}${parseExtraBadges(v.title)}`, callback_data: `br_mq_${v.token}_${m.firstToken}` },
        ]);
        qualButtons.push([
          { text: "▶️ Watch Trailer / ට්‍රේලර් බලන්න", url: trailerUrl },
        ]);
        qualButtons.push([
          { text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" },
        ]);

        if (editCb) {
          await editTelegramMessage(env, editCb, caption, { inline_keyboard: qualButtons });
        } else {
          await sendSearchReply(env, chatId, poster, caption, qualButtons, replyToMsgId);
        }
        return;
      } else {
        // Single quality -> Direct Download
        const v = sortedVariants[0] || m.variants[0];
        const qObj = parseQuality(v.title);
        const startUrl = `https://t.me/${botUsername}?start=${v.token}`;
        const caption = `🎬 <b>${escapeHtml(m.rootTitle)}</b>${yearStr} [${qObj.raw}${parseExtraBadges(v.title)}]\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}━━━━━━━━━━━━━━━━━━━━\n📥 <b>File Ready for Download!</b>\n\n👉 පහත <b>'⚡ Download ⚡'</b> Button එක ඔබන්න.\n👉 එවිට Bot Private Chat එක Open වේ. එතන Ad එක නරඹා File එක ලබාගන්න.`;
        const kb = [
          [{ text: `⚡ Download (${qObj.raw}) ⚡`, url: startUrl }],
          [{ text: "▶️ Watch Trailer / ට්‍රේලර් බලන්න", url: trailerUrl }],
          [{ text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" }],
        ];

        if (editCb) {
          await editTelegramMessage(env, editCb, caption, { inline_keyboard: kb });
        } else {
          await sendSearchReply(env, chatId, poster, caption, kb, replyToMsgId);
        }
        return;
      }
    }

    // Subcase 3: Multiple titles or Mixed Movies & Series -> Interactive List with Tabs!
    const effectiveTab = activeTab || (hasMovies ? "movies" : "series");
    const kbRows = [];
    const rootToken = movieList[0]?.firstToken || seriesList[0]?.firstToken || "search";

    // Tab Header if both Movies and Series exist (Inspired by Image 2!)
    if (hasMovies && hasSeries) {
      kbRows.push([
        {
          text: effectiveTab === "movies" ? `🔘 🎬 Movies (${movieList.length})` : `🎬 Movies (${movieList.length})`,
          callback_data: `br_tab_mov_${rootToken}`,
        },
        {
          text: effectiveTab === "series" ? `🔘 📺 Series (${seriesList.length})` : `📺 Series (${seriesList.length})`,
          callback_data: `br_tab_ser_${rootToken}`,
        },
      ]);
    }

    // Tab Content
    if (effectiveTab === "movies" && hasMovies) {
      for (const m of movieList.slice(0, 10)) {
        const qualCount = m.variants.length > 1 ? ` (${m.variants.length} Qualities)` : "";
        kbRows.push([
          { text: `🎬 ${m.rootTitle}${qualCount}`, callback_data: `br_mov_${m.firstToken}` },
        ]);
      }
    } else if (hasSeries) {
      for (const s of seriesList.slice(0, 10)) {
        kbRows.push([
          { text: `📺 ${s.name} (${s.seasons.size} Season${s.seasons.size > 1 ? "s" : ""})`, callback_data: `br_ser_${s.firstToken}` },
        ]);
      }
    }

    // Not found in this list? 1-Click Request Button (Inspired by Image 2 "මෙතන නෑනේ")
    const cleanSearchQuery = encodeURIComponent(query.slice(0, 30));
    kbRows.push([
      { text: "🥺 මෙතන නෑනේ / Request Title", callback_data: `req_search_${cleanSearchQuery}` },
    ]);

    kbRows.push([
      { text: "👑 Get VIP (Zero Ads / Unlimited)", callback_data: "vip_pay_bank" },
    ]);

    const poster = tmdb?.poster || seriesList[0]?.poster || movieList[0]?.poster || null;
    const yearStr = tmdb?.year ? ` (${tmdb.year})` : "";
    const ratingStr = tmdb?.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
    const tabNote = hasMovies && hasSeries
      ? `\n📌 <i>ඔයා හොයන්නේ Series නම් 'Series' Button එක ඔබලා Series එක තෝරන්න.</i>`
      : "";

    const caption = `👋 <b>බලන්න ඔයා හොයන Title එක මෙතන තියනවද කියලා..</b> 👇\n━━━━━━━━━━━━━━━━━━━━\n🔍 <b>Search:</b> <i>${escapeHtml(query)}</i>${yearStr}\n${ratingStr}${tabNote}\n━━━━━━━━━━━━━━━━━━━━\n👇 පහතින් ඔබට අවශ්‍ය Movie හෝ Series එක තෝරන්න:`;

    if (editCb) {
      await editTelegramMessage(env, editCb, caption, { inline_keyboard: kbRows });
    } else {
      await sendSearchReply(env, chatId, poster, caption, kbRows, replyToMsgId);
    }
    return;
  }

  // Case B: Not found in D1, but found on TMDb
  if (tmdb) {
    const yearStr = tmdb.year ? ` (${tmdb.year})` : "";
    const ratingStr = tmdb.rating ? `⭐️ <b>Rating:</b> ${tmdb.rating} / 10\n` : "";
    const overviewStr = tmdb.overview ? `📝 <i>${escapeHtml(tmdb.overview)}</i>\n` : "";
    const trailerUrl = tmdb.trailer || getTrailerUrl(tmdb.title);

    const caption = `🎬 <b>${escapeHtml(tmdb.title)}</b>${yearStr}\n${ratingStr}━━━━━━━━━━━━━━━━━━━━\n${overviewStr}━━━━━━━━━━━━━━━━━━━━\n⚠️ <b>මෙම Title එක තවමත් PixelPop හි නොමැත!</b>\n<i>(This title is not in our database yet)</i>\n\n👇 <b>ඔබට මෙය අවශ්‍ය නම් පහත Button එකෙන් Request කරන්න:</b>`;

    const cleanTitle = (tmdb.title || query).slice(0, 40);
    const reqKb = [
      [{ text: "📢 Request this Title / අපෙන් ඉල්ලන්න", callback_data: `req_movie_${cleanTitle}` }],
      [{ text: "▶️ Watch Trailer / ට්‍රේලර් බලන්න", url: trailerUrl }],
      [{ text: "👑 Get VIP Membership", callback_data: "vip_pay_bank" }],
    ];

    if (editCb) {
      await editTelegramMessage(env, editCb, caption, { inline_keyboard: reqKb });
    } else {
      await sendSearchReply(env, chatId, tmdb.poster, caption, reqKb, replyToMsgId);
    }
    return;
  }

  // If in group and not an explicit search, stay silent to avoid spamming
  if (isGroup && !isExplicitSearch) {
    return;
  }

  // Case C: Neither found
  const cleanTitle = query.slice(0, 40);
  const notFoundKb = [
    [{ text: "📢 Request Movie / අපෙන් ඉල්ලන්න", callback_data: `req_movie_${cleanTitle}` }],
  ];

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    reply_to_message_id: replyToMsgId || undefined,
    parse_mode: "HTML",
    text: `🔍 <b>'${escapeHtml(query)}' හමු නොවීය!</b>\n━━━━━━━━━━━━━━━━━━━━\nනම නිවැරදිදැයි පරීක්ෂා කර නැවත Search කරන්න.\n\n💡 <b>අපෙන් ඉල්ලීමට:</b>\n<code>/request ${escapeHtml(query)}</code> ලෙස Type කරන්න හෝ පහත Button එක ඔබන්න.`,
    reply_markup: { inline_keyboard: notFoundKb },
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
      "ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN daily_downloads INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN quota_reset_at INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN token_created_at INTEGER DEFAULT 0",
      "ALTER TABLE batches ADD COLUMN series_name TEXT",
      "ALTER TABLE batches ADD COLUMN season INTEGER DEFAULT 1",
      "ALTER TABLE batches ADD COLUMN episode INTEGER DEFAULT 0",
      "ALTER TABLE batches ADD COLUMN quality TEXT",
      "CREATE INDEX IF NOT EXISTS idx_batches_series ON batches(series_name)",
      "CREATE INDEX IF NOT EXISTS idx_batches_season ON batches(series_name, season)",
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
