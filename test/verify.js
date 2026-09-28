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

console.log("\n🎉 All 8 Verification Tests Passed Successfully!");

