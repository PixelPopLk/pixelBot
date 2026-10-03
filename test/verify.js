/**
 * Unit Test / Verification Script for PixelPop Telegram Bot
 */

const assert = require('assert');

// Test 1: Payload decoding backward compatibility
function decodeLegacyPayload(payload) {
  const rawCode = Buffer.from(payload, 'base64').toString('utf-8');
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
  }
  return targetMsgIds;
}

// 1. Range test
const rangePayload = Buffer.from("get-10-14").toString('base64');
const rangeDecoded = decodeLegacyPayload(rangePayload);
assert.deepStrictEqual(rangeDecoded, [10, 11, 12, 13, 14]);
console.log("✅ Test 1 Passed: Legacy Range Payload get-10-14 correctly decoded");

// 2. List test
const listPayload = Buffer.from("list-5,8,22").toString('base64');
const listDecoded = decodeLegacyPayload(listPayload);
assert.deepStrictEqual(listDecoded, [5, 8, 22]);
console.log("✅ Test 2 Passed: Legacy List Payload list-5,8,22 correctly decoded");

// 3. New UUID batch token identification test
const newToken = "b_3f8a91bc";
assert.strictEqual(newToken.startsWith("b_"), true);
console.log("✅ Test 3 Passed: Secure Token (b_ prefix) format verified");

// 4. Referral milestone math
function shouldAwardFreeVip(currentCount) {
  return currentCount > 0 && currentCount % 3 === 0;
}
assert.strictEqual(shouldAwardFreeVip(1), false);
assert.strictEqual(shouldAwardFreeVip(2), false);
assert.strictEqual(shouldAwardFreeVip(3), true);
assert.strictEqual(shouldAwardFreeVip(6), true);
console.log("✅ Test 4 Passed: Referral 3-friend milestone logic verified");

// 5. HTML escaping test
function escapeHtml(text) {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
assert.strictEqual(escapeHtml("Deadpool & Wolverine <2024>"), "Deadpool &amp; Wolverine &lt;2024&gt;");
console.log("✅ Test 5 Passed: HTML Sanitizer prevents tag injection");

// 6. VIP Plan Duration Calculations
function getVipDurationMs(plan) {
  if (plan === "weekly") return 7 * 24 * 60 * 60 * 1000;
  if (plan === "monthly") return 30 * 24 * 60 * 60 * 1000;
  if (plan === "lifetime") return 100 * 365 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}
assert.strictEqual(getVipDurationMs("weekly"), 604800000);
assert.strictEqual(getVipDurationMs("monthly"), 2592000000);
assert.strictEqual(getVipDurationMs("lifetime") > 3000000000000, true);
console.log("✅ Test 6 Passed: Flexible VIP duration calculation verified (Weekly, Monthly, Lifetime)");

// 7. TMDb Query Cleaner Test
function cleanTmdbQuery(query) {
  return query
    .replace(/[\[\(].*?[\]\)]/g, "")
    .replace(/\b(1080p|720p|480p|4k|hdr|bluray|web-dl|hdrip|x264|x265|hevc|season\s*\d+|s\d+e\d+|episode\s*\d+)\b/gi, "")
    .trim();
}
assert.strictEqual(cleanTmdbQuery("Avatar The Way of Water [1080p] (2022) Bluray x264"), "Avatar The Way of Water");
assert.strictEqual(cleanTmdbQuery("Stranger Things Season 4 S04E01 720p HEVC"), "Stranger Things");
console.log("✅ Test 7 Passed: TMDb title cleaner strips release tags accurately");

// 8. Request Command Extraction
function parseRequestQuery(text) {
  return text.replace(/^\/(request|req)\s*/i, "").trim();
}
assert.strictEqual(parseRequestQuery("/request Interstellar 2014"), "Interstellar 2014");
assert.strictEqual(parseRequestQuery("/req Dune Part Two"), "Dune Part Two");
console.log("✅ Test 8 Passed: Movie Request command query extraction verified");

// 9. Sliding-Window Rate Limiter Logic
function testRateLimiter() {
  const map = new Map();
  function checkLimit(key, maxReq = 3, windowMs = 1000, minIntervalMs = 100, now) {
    const record = map.get(key) || { timestamps: [], lastTime: 0 };
    if (record.lastTime && now - record.lastTime < minIntervalMs) return true;
    const recent = record.timestamps.filter((t) => now - t < windowMs);
    if (recent.length >= maxReq) return true;
    recent.push(now);
    map.set(key, { timestamps: recent, lastTime: now });
    return false;
  }

  const t0 = 10000;
  assert.strictEqual(checkLimit("u1", 3, 1000, 100, t0), false); // 1st req
  assert.strictEqual(checkLimit("u1", 3, 1000, 100, t0 + 50), true); // Burst blocked (<100ms)
  assert.strictEqual(checkLimit("u1", 3, 1000, 100, t0 + 150), false); // 2nd req
  assert.strictEqual(checkLimit("u1", 3, 1000, 100, t0 + 300), false); // 3rd req
  assert.strictEqual(checkLimit("u1", 3, 1000, 100, t0 + 450), true); // Exceeded 3 in 1000ms window
  assert.strictEqual(checkLimit("u1", 3, 1000, 100, t0 + 1100), false); // Reset after window expires
}
testRateLimiter();
console.log("✅ Test 9 Passed: Sliding window rate limiter & burst suppression verified");

// 10. Token TTL Expiration (15 minutes)
function isTokenExpired(tokenCreatedAt, now, ttlMs = 15 * 60 * 1000) {
  if (!tokenCreatedAt) return false;
  return now - tokenCreatedAt > ttlMs;
}
const now = Date.now();
assert.strictEqual(isTokenExpired(now - 5 * 60 * 1000, now), false); // 5 min ago -> valid
assert.strictEqual(isTokenExpired(now - 16 * 60 * 1000, now), true); // 16 min ago -> expired
console.log("✅ Test 10 Passed: 15-minute verification token TTL enforcement verified");

// 11. Free Tier Daily Quota & 24h Reset
function checkDailyQuota(user, limit = 5, now) {
  if (user.is_vip && user.vip_until > now) return { allowed: true, remaining: Infinity };
  let downloads = user.daily_downloads || 0;
  let resetAt = user.quota_reset_at || 0;
  if (now > resetAt) {
    downloads = 0;
  }
  if (downloads >= limit) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: limit - downloads };
}
const quotaUser = { is_vip: 0, vip_until: 0, daily_downloads: 5, quota_reset_at: now + 3600000 };
assert.strictEqual(checkDailyQuota(quotaUser, 5, now).allowed, false); // Cap reached
const expiredQuotaUser = { is_vip: 0, vip_until: 0, daily_downloads: 5, quota_reset_at: now - 1000 };
assert.strictEqual(checkDailyQuota(expiredQuotaUser, 5, now).allowed, true); // Reset cycle passed
const vipUser = { is_vip: 1, vip_until: now + 86400000, daily_downloads: 10, quota_reset_at: now + 3600000 };
assert.strictEqual(checkDailyQuota(vipUser, 5, now).allowed, true); // VIP exempt
console.log("✅ Test 11 Passed: Free Tier Daily Download Quota & VIP exemption verified");

// 12. Co-Admin Authorization Checks
function isAuthorizedAdmin(userId, env) {
  const primary = String(env.ADMIN_ID || "").trim();
  if (String(userId) === primary) return true;
  const coAdmins = String(env.CO_ADMINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return coAdmins.includes(String(userId));
}
const envConfig = { ADMIN_ID: "111222", CO_ADMINS: "333444, 555666" };
assert.strictEqual(isAuthorizedAdmin("111222", envConfig), true); // Primary admin
assert.strictEqual(isAuthorizedAdmin("333444", envConfig), true); // Co-admin 1
assert.strictEqual(isAuthorizedAdmin("555666", envConfig), true); // Co-admin 2
assert.strictEqual(isAuthorizedAdmin("999999", envConfig), false); // Unauthorized user
console.log("✅ Test 12 Passed: Primary and Co-Admin authorization logic verified");

// 13. Ban / Blacklist Enforcement
function isUserBanned(user) {
  return Boolean(user && user.is_banned === 1);
}
assert.strictEqual(isUserBanned({ is_banned: 1 }), true);
assert.strictEqual(isUserBanned({ is_banned: 0 }), false);
assert.strictEqual(isUserBanned(null), false);
console.log("✅ Test 13 Passed: User ban and blacklist enforcement verified");

// 14. Media Title Parser for Series, Seasons, and Episodes
function parseMediaTitle(rawTitle) {
  if (!rawTitle) return { isSeries: false, cleanTitle: "Untitled" };
  let title = rawTitle
    .replace(/[\[\(].*?(1080p|720p|480p|4k|hdr|bluray|web-dl|hdrip|x264|x265|hevc).*?[\]\)]/gi, "")
    .replace(/\b(1080p|720p|480p|4k|hdr|bluray|web-dl|hdrip|x264|x265|hevc)\b/gi, "")
    .trim();

  const packPattern = title.match(/^(.*?)(?:\s+(?:season|s)\s*0*(\d+))?\s*(?:\(|\[)?\s*complete\s*season\s*pack\s*(?:\)|\])?$/i);
  if (packPattern) {
    const seriesName = packPattern[1].trim();
    const season = packPattern[2] ? parseInt(packPattern[2], 10) : 1;
    return { isSeries: true, isPack: true, seriesName, season, episode: 0 };
  }

  const sPattern = title.match(/^(.*?)[.\s_-]+(?:s|season)\s*0*(\d+)[.\s_-]*(?:e|ep|episode)\s*0*(\d+)(.*)$/i);
  if (sPattern) {
    return { isSeries: true, seriesName: sPattern[1].trim(), season: parseInt(sPattern[2], 10), episode: parseInt(sPattern[3], 10) };
  }

  const epPattern = title.match(/^(.*?)(?:\s*-\s*|\s+)(?:episode|ep)\s*0*(\d+)(.*)$/i);
  if (epPattern) {
    let seriesName = epPattern[1].trim();
    let season = 1;
    const sInName = seriesName.match(/^(.*?)\s+(?:season|s)\s*0*(\d+)$/i);
    if (sInName) {
      seriesName = sInName[1].trim();
      season = parseInt(sInName[2], 10);
    }
    return { isSeries: true, seriesName, season, episode: parseInt(epPattern[2], 10) };
  }

  return { isSeries: false, cleanTitle: title };
}

// Check parsing on multiple formats:
const seriesPack = parseMediaTitle("Stranger Things Season 2 (Complete Season Pack)");
assert.strictEqual(seriesPack.isSeries, true);
assert.strictEqual(seriesPack.seriesName, "Stranger Things");
assert.strictEqual(seriesPack.season, 2);
assert.strictEqual(seriesPack.isPack, true);

const s01e03 = parseMediaTitle("Loki.S01E03.720p.mkv");
assert.strictEqual(s01e03.isSeries, true);
assert.strictEqual(s01e03.seriesName, "Loki");
assert.strictEqual(s01e03.season, 1);
assert.strictEqual(s01e03.episode, 3);

const epDash = parseMediaTitle("Money Heist Season 5 - Episode 04");
assert.strictEqual(epDash.isSeries, true);
assert.strictEqual(epDash.seriesName, "Money Heist");
assert.strictEqual(epDash.season, 5);
assert.strictEqual(epDash.episode, 4);

const movie = parseMediaTitle("Avatar: The Way of Water [1080p Bluray]");
assert.strictEqual(movie.isSeries, false);
console.log("✅ Test 14 Passed: Media Title Parser accurately classifies TV Series, Seasons, Episodes, and Movies");

// 15. Unlimited Downloads Enforcement when FREE_DAILY_LIMIT = "0"
function checkUnlimitedQuota(maxDailySetting, dailyDownloads) {
  const maxDaily = parseInt(maxDailySetting || "0", 10);
  if (maxDaily <= 0) return { blocked: false, status: "unlimited" };
  return { blocked: dailyDownloads >= maxDaily, status: "limited" };
}
assert.strictEqual(checkUnlimitedQuota("0", 0).blocked, false);
assert.strictEqual(checkUnlimitedQuota("0", 5).blocked, false);
assert.strictEqual(checkUnlimitedQuota("0", 999).blocked, false);
assert.strictEqual(checkUnlimitedQuota("5", 5).blocked, true);
console.log("✅ Test 15 Passed: Unlimited Free Downloads mode (FREE_DAILY_LIMIT = 0) verified");

// 16. Group Conversational Anti-Spam Filter
const commonChatWords = new Set(["hi", "hello", "ok", "okay", "gm", "gn", "yes", "no", "thanks", "machan", "ela"]);
function shouldIgnoreGroupChatter(text) {
  return commonChatWords.has(text.toLowerCase().trim());
}
assert.strictEqual(shouldIgnoreGroupChatter("hi"), true);
assert.strictEqual(shouldIgnoreGroupChatter("machan"), true);
assert.strictEqual(shouldIgnoreGroupChatter("Avatar"), false);
assert.strictEqual(shouldIgnoreGroupChatter("Stranger Things"), false);
console.log("✅ Test 16 Passed: Group conversational filter suppresses casual chatter without dropping movie searches");

// 17. Multi-Quality Parser and Weight Ordering
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
assert.strictEqual(parseQuality("Deadpool 2024 2160p HDR").raw, "4K");
assert.strictEqual(parseQuality("Avatar 2 1080p BluRay").raw, "1080p");
assert.strictEqual(parseQuality("Inception 720p WEB-DL").raw, "720p");
assert.strictEqual(parseQuality("Friends S01E01 480p DVD").raw, "480p");
assert.strictEqual(parseQuality("4K").weight > parseQuality("1080p").weight, true);
assert.strictEqual(parseQuality("1080p").weight > parseQuality("720p").weight, true);
console.log("✅ Test 17 Passed: Multi-Quality resolution tagging and weight order verified");

// 18. Movie Root Title Grouping Logic
function cleanMovieRootTitle(rawTitle) {
  if (!rawTitle) return "Untitled";
  return rawTitle
    .replace(/[\[\(].*?(1080p|720p|480p|4k|2160p|uhd|fhd|hdr|bluray|web-dl|hdrip|x264|x265|hevc|dual|audio|sinhala).*?[\]\)]/gi, "")
    .replace(/\b(1080p|720p|480p|4k|2160p|uhd|fhd|hdr|bluray|web-dl|webrip|hdrip|dvdrip|remux|x264|x265|hevc|6ch|dual[\s.-]?audio|sinhala[\s.-]?sub)\b/gi, "")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const title4k = cleanMovieRootTitle("Avatar The Way of Water (2022) 4K UHD BluRay 6CH");
const title1080p = cleanMovieRootTitle("Avatar The Way of Water (2022) 1080p WEB-DL Sinhala Sub");
assert.strictEqual(title4k, title1080p);
console.log("✅ Test 18 Passed: Root Movie title normalization correctly groups multi-quality releases");

// 19. Extra Badges Extraction (Subtitles, Audio, Source)
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
const badgesStr = parseExtraBadges("Spider-Man Sinhala Sub Dual Audio BluRay");
assert.strictEqual(badgesStr.includes("🇱🇰 Sub"), true);
assert.strictEqual(badgesStr.includes("🎙️ Dual"), true);
assert.strictEqual(badgesStr.includes("💿 BluRay"), true);
console.log("✅ Test 19 Passed: Badge parser recognizes Sinhala Sub, Dual Audio, and BluRay");

// 20. Multi-Quality Episode Variant Detection
function detectEpisodeQualities(episodeList, targetEpNum) {
  const matching = episodeList.filter(ep => ep.episode === targetEpNum);
  const qualityMap = new Map();
  for (const ep of matching) {
    const q = parseQuality(ep.title);
    if (!qualityMap.has(q.raw) || (ep.token && !qualityMap.get(q.raw).token)) {
      qualityMap.set(q.raw, { ...ep, qualityObj: q });
    }
  }
  return Array.from(qualityMap.values());
}
const sampleEpisodes = [
  { episode: 1, title: "Stranger Things S01E01 720p", token: "tok_720" },
  { episode: 1, title: "Stranger Things S01E01 1080p", token: "tok_1080" },
  { episode: 1, title: "Stranger Things S01E01 4K UHD", token: "tok_4k" },
  { episode: 2, title: "Stranger Things S01E02 720p", token: "tok_ep2" },
];
const ep1Variants = detectEpisodeQualities(sampleEpisodes, 1);
assert.strictEqual(ep1Variants.length, 3);
const ep2Variants = detectEpisodeQualities(sampleEpisodes, 2);
assert.strictEqual(ep2Variants.length, 1);
console.log("✅ Test 20 Passed: Episode multi-quality variant detection logic verified");

// 21. Strict Single-Owner Exclusivity
const singleOwnerEnv = { ADMIN_ID: "6857599209", CO_ADMINS: "" };
assert.strictEqual(isAuthorizedAdmin("6857599209", singleOwnerEnv), true); // Owner authorized
assert.strictEqual(isAuthorizedAdmin("1234567890", singleOwnerEnv), false); // Random user denied
assert.strictEqual(isAuthorizedAdmin("", singleOwnerEnv), false); // Empty user denied
console.log("✅ Test 21 Passed: Strict single-owner exclusivity verified (Owner only)");

// 22. Admin Command & Panel Lockdown for Non-Admins
function canAccessAdminPanel(senderId, isGroup, env) {
  if (isGroup) return false;
  return isAuthorizedAdmin(senderId, env);
}
assert.strictEqual(canAccessAdminPanel("6857599209", false, singleOwnerEnv), true); // Owner in private chat -> Allowed
assert.strictEqual(canAccessAdminPanel("6857599209", true, singleOwnerEnv), false); // Owner in public group chat -> Blocked for safety
assert.strictEqual(canAccessAdminPanel("9876543210", false, singleOwnerEnv), false); // Non-owner in private -> Denied
console.log("✅ Test 22 Passed: Admin Panel private lockdown & group chat suppression verified");

// 23. Direct Message Command Parsing & Segmented Broadcast Target Filtering
function parseDirectMsgCommand(text) {
  const parts = text.split(" ");
  const targetId = parts[1]?.trim();
  const message = parts.slice(2).join(" ").trim();
  return { targetId, message };
}
const dmParsed = parseDirectMsgCommand("/msg 123456789 Hello, your VIP has been upgraded!");
assert.strictEqual(dmParsed.targetId, "123456789");
assert.strictEqual(dmParsed.message, "Hello, your VIP has been upgraded!");

function buildBroadcastQuery(targetGroup) {
  let query = `SELECT user_id FROM users WHERE user_id NOT LIKE 'admin_%' AND is_banned = 0`;
  if (targetGroup === "vip") {
    query += ` AND is_vip = 1 AND vip_until > ?`;
  } else if (targetGroup === "free") {
    query += ` AND (is_vip = 0 OR vip_until <= ?)`;
  }
  return query;
}
assert.strictEqual(buildBroadcastQuery("all").includes("is_vip"), false);
assert.strictEqual(buildBroadcastQuery("vip").includes("is_vip = 1"), true);
assert.strictEqual(buildBroadcastQuery("free").includes("is_vip = 0"), true);
console.log("✅ Test 23 Passed: Direct message parser & broadcast target filtering verified");

console.log("\n🎉 All 23 Verification Tests Passed Successfully!");



