// saad-bot.js
// =============================================================================
// Saad-Bot (Single File Recode) – Baileys WhatsApp bot
// Features:
// - Command parsing with/without prefix
// - Owner + Group/User authorization
// - Cooldowns (generic + AI)
// - Instagram Reels downloader (yt-dlp)
// - Clash of Clans commands: setclan/removeclan, claninfo, player, playerstats,
//   clanmembers, warlog, warlogs, cm (player index), attendance (last month),
//   whenwar (remaining time for current war)
// - War autosave (savedWars.json) + notifications ticker
// - AI mode (Groq placeholder) with chat history
// - Self-message loop-safe (owner allowed)
// - Persistent DB (db.json) + error-safe loads
// =============================================================================

// ------------------------- 🧱 Imports & Setup -------------------------
require('dotenv').config();
const Pino = require('pino');
const pino = Pino;
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const fetch = require('node-fetch'); // v2
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  isJidGroup
} = require('@whiskeysockets/baileys');

// ------------------------- ⚙️ Config -------------------------
const CONFIG = {
  BOT_NAME: process.env.BOT_NAME || 'Saad-Bot',
  OWNER_JID: (process.env.OWNER_JID || '').trim(), // e.g., 91XXXXXXXXXX@s.whatsapp.net
  COMMAND_PREFIX: (process.env.COMMAND_PREFIX || '').trim(),
  AUTH_DIR: path.join(__dirname, 'auth'),
  STATE_DIR: path.join(__dirname, 'state'),
  DB_FILE: path.join(__dirname, 'db.json'),
  SAVED_WARS_FILE: path.join(__dirname, 'savedWars.json'),
  COC_API_KEY: process.env.COC_API_KEY || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  // cooldowns
CMD_COOLDOWN_SEC: parseFloat(process.env.CMD_COOLDOWN_SEC || '0.4'),
AI_COOLDOWN_SEC: parseFloat(process.env.AI_COOLDOWN_SEC || '0.4'),
};

if (!fs.existsSync(CONFIG.STATE_DIR)) fs.mkdirSync(CONFIG.STATE_DIR, { recursive: true });

// ------------------------- 💾 Persistent DB (safe, atomic) -------------------------
const DEFAULT_DB = {
  authorisedUsers: {},
  authorisedGroups: {},
  aiModeUsers: {},
  aiChatHistory: {},
  groupMemberClans: {},   // <--- add this line
  userClans: {},
  lastKnownClanMembers: {},
  welcomedUsers: {},
  dailyStats: {},
  lastKnownPlayerWarStats: {},
  lastMessages: {},
  lastFetchTimes: {},
  activeWarWatchers: {},
  lastWarNotificationSent: {},
  lastWarlogPlayers: {},
  playerWarLogs: {},        // required: playerTag -> [logs]
  attendanceLogs: {},       // clanTag -> attendance summary
  removedClanLogs: {},      // clanTag -> backup
  pendingFinalization: {}   // clanTag -> boolean
};

// In-memory DB (start with defaults)
let DB = { ...DEFAULT_DB };

/**
 * Ensure DB has required buckets after loading/merging.
 */
function ensureDBDefaults() {
  for (const [k, v] of Object.entries(DEFAULT_DB)) {
    if (DB[k] === undefined || DB[k] === null) {
      DB[k] = Array.isArray(v) ? [] : (typeof v === 'object' ? { ...v } : v);
    }
  }
}

/**
 * Atomic save: write to tmp file then rename. Handles errors gracefully.
 */
const saveDB = (force = false) => {
  try {
    const tmpFile = CONFIG.DB_FILE + '.tmp';
    const data = JSON.stringify(DB, null, 2);

    // If not forced, attempt to skip write when nothing changed could be added (left simple here)
    fs.writeFileSync(tmpFile, data, { encoding: 'utf-8' });
    fs.renameSync(tmpFile, CONFIG.DB_FILE);
    // console.log('DB saved to', CONFIG.DB_FILE);
  } catch (e) {
    try {
      // cleanup tmp file if something partial left
      const tmpFile = CONFIG.DB_FILE + '.tmp';
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
    console.error('Failed to save DB:', e && e.message ? e.message : e);
  }
};

/**
 * Load DB from disk; on JSON parse error, back up corrupt file and start fresh.
 * Merge only object keys from saved file into in-memory DEFAULTS to avoid unexpected shape changes.
 */
const loadDB = () => {
  try {
    if (!fs.existsSync(CONFIG.DB_FILE)) {
      // no file, keep defaults
      ensureDBDefaults();
      return;
    }

    const raw = fs.readFileSync(CONFIG.DB_FILE, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (jsonErr) {
      // Backup corrupt file with timestamp and continue with defaults
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const corruptBak = `${CONFIG.DB_FILE}.corrupt.${ts}.bak`;
        fs.renameSync(CONFIG.DB_FILE, corruptBak);
        console.error(`DB file was corrupt; moved to ${corruptBak}. Starting with fresh DB.`);
      } catch (bakErr) {
        console.error('Failed to backup corrupt DB file:', bakErr && bakErr.message ? bakErr.message : bakErr);
      }
      parsed = {};
    }

    // Merge: only copy keys from parsed if the value type matches DEFAULT_DB's type (object/array/primitive)
    for (const [key, defVal] of Object.entries(DEFAULT_DB)) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        const parsedVal = parsed[key];

        // If both are plain objects -> shallow merge
        if (isPlainObject(defVal) && isPlainObject(parsedVal)) {
          DB[key] = { ...defVal, ...parsedVal };
        }
        // If both are arrays -> take parsed array
        else if (Array.isArray(defVal) && Array.isArray(parsedVal)) {
          DB[key] = parsedVal.slice();
        }
        // If default is object but parsed is array (or vice versa) or types differ => prefer default (safer)
        else if (typeof defVal === typeof parsedVal) {
          DB[key] = parsedVal;
        } else {
          // keep default
          DB[key] = Array.isArray(defVal) ? [] : (isPlainObject(defVal) ? { ...defVal } : defVal);
        }
      } else {
        // not present in parsed -> use default
        DB[key] = Array.isArray(defVal) ? [] : (isPlainObject(defVal) ? { ...defVal } : defVal);
      }
    }

    // Any extra keys in parsed that are not in DEFAULT_DB: copy them as-is (preserve custom fields)
    for (const k of Object.keys(parsed || {})) {
      if (!Object.prototype.hasOwnProperty.call(DB, k)) {
        DB[k] = parsed[k];
      }
    }
  } catch (e) {
    console.error('Failed to load DB, starting fresh:', e && e.message ? e.message : e);
    DB = { ...DEFAULT_DB };
  } finally {
    ensureDBDefaults();
  }
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// load once at startup
loadDB();

// auto-save on process exit / signals to avoid data loss
const safeSaveAndExit = (code = 0) => {
  try {
    saveDB(true);
  } catch (_) {}
  try { process.exit(code); } catch (_) {}
};

process.on('SIGINT', () => safeSaveAndExit(0));
process.on('SIGTERM', () => safeSaveAndExit(0));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  safeSaveAndExit(1);
});
process.on('beforeExit', () => {
  try { saveDB(true); } catch (_) {}
});

// Optionally expose a manual helper if you want to force-save from other modules
globalThis.saveDBAtomic = saveDB;

// ------------------------- 🧰 Utils -------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

const formatUptime = (secs) => {
  secs = Math.floor(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${m}m ${s}s`;
};

const now = () => Date.now();

// cooldowns
const cooldowns = new Map(); // key: sender, val: { t: lastTime, dur: seconds}
const isOnCooldown = (sender, dur = CONFIG.CMD_COOLDOWN_SEC) => {
  const e = cooldowns.get(sender);
  if (!e) return false;
  const elapsed = (now() - e.t) / 1000;
  return elapsed < e.dur;
};
const setCooldown = (sender, dur = CONFIG.CMD_COOLDOWN_SEC) => {
  cooldowns.set(sender, { t: now(), dur });
};

// ------------------------- 🌐 CoC API Helper -------------------------
async function cocFetch(endpoint) {
  try {
    if (!CONFIG.COC_API_KEY) {
      return { error: true, message: 'COC_API_KEY not set in .env' };
    }

    // 🧹 Always trim token
    const token = CONFIG.COC_API_KEY.trim();
    const base = 'https://api.clashofclans.com/v1';
    const url = `${base}${endpoint}`;

    // Debug info
   // console.log("=== CoC API DEBUG ===");
   // console.log("[DEBUG] Request URL:", url);
   // console.log("[DEBUG] Using Token (first 40 chars):", token.slice(0, 40) + "...");
    
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.reason || j.message || text;
      } catch (_) {}
     // console.error("[DEBUG] API Error Response:", text);
      return { error: true, status: res.status, message: msg };
    }

    const json = await res.json();
 // console.log("[DEBUG] API Success ✅");
    return json;

  } catch (e) {
  //console.error("[DEBUG] Fetch Exception:", e.message);
    return { error: true, message: e.message };
  }
}

// ------------------------- 💾 Saved Wars Buffer -------------------------
let savedWars = [];
try {
  if (fs.existsSync(CONFIG.SAVED_WARS_FILE)) {
    savedWars = JSON.parse(fs.readFileSync(CONFIG.SAVED_WARS_FILE, 'utf-8'));
  }
} catch (e) {
  console.error('Error reading saved wars file, resetting.', e);
  savedWars = [];
}

function saveWarsToFile() {
  try {
    fs.writeFileSync(CONFIG.SAVED_WARS_FILE, JSON.stringify(savedWars, null, 2));
  } catch (e) {
    console.error('Failed saving savedWars:', e.message);
  }
}

async function fetchCurrentWar(clanTag) {
  const res = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
  if (res.error) throw new Error(`API error: ${res.status || 'N/A'} ${res.message}`);
  return res;
}

async function checkAndSaveWar(clanTag) {
  if (!clanTag) return;
  try {
    const war = await fetchCurrentWar(clanTag);
    // Save only ended wars with at least one attack
    if (war.state === 'warEnded' && war.clan?.attacks > 0) {
      if (!savedWars.find(w => w.startTime === war.startTime)) {
        savedWars.unshift(war);
        if (savedWars.length > 10) savedWars.pop();
        saveWarsToFile();
        console.log('Saved ended war:', war.startTime);
      }
    }
  } catch (e) {
    console.error('Error in checkAndSaveWar:', e.message);
  }
}

function getSavedWars() {
  return savedWars;
}

// ------------------------- 🧾 War Formatting -------------------------
function formatWarlogDetails(war) {
  try {
    if (!war || !war.clan || !war.clan.members) {
      return { error: true, message: "War data is incomplete or unavailable." };
    }

    const stateText = war.state === 'inWar' ? 'Current Live War' : 'War Log';
    const resultText = war.state === 'warEnded' ? ` (Result: ${war.result || 'N/A'})` : '';
    let report = `📖 *${stateText}* *for ${war.clan.name} vs ${war.opponent?.name || 'Unknown'}${resultText}*:\n\n`;

    // show members in roster order (as provided)
    war.clan.members.forEach((member, index) => {
      report += `${index + 1}. Name: ${member.name}\n`;
      report += `  Attacks:\n`;
      if (member.attacks && member.attacks.length > 0) {
        member.attacks.forEach((attack, attackIndex) => {
          report += `  Attack ${attackIndex + 1}: ${attack.stars}⭐, ${attack.destructionPercentage}%\n`;
        });
      } else {
        report += `  Attack 1: Attack not used\n`;
        report += `  Attack 2: Attack not used\n`;
      }
      report += `\n`;
    });

    return { success: true, message: report };
  } catch (e) {
    return { error: true, message: `Formatter failed: ${e.message}` };
  }
}

// ------------------------- 🧑‍🤝‍🧑 Player War History -------------------------
async function getPlayerWarHistory(clanTag, playerIndex) {
  try {
    const wars = getSavedWars();
    if (!wars || wars.length === 0) {
      return { error: true, message: "No recent war data found." };
    }

    const memberList = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/members`);
    if (memberList.error || !memberList.items) {
      return { error: true, message: memberList.message || '❌ Could not get clan member list.' };
    }

    if (playerIndex > memberList.items.length) {
      return { error: true, message: `Invalid player number. Please provide a player number between 1 and ${memberList.items.length}.` };
    }

    const playerTag = memberList.items[playerIndex - 1].tag;
    const playerName = memberList.items[playerIndex - 1].name;

    let report = `*Last ${wars.length} War Attacks for ${playerName}:*\n\n`;

    wars.forEach((war, index) => {
      const member = war.clan.members.find(m => m.tag === playerTag);
      if (member) {
        const attack1 = member.attacks ? member.attacks[0] : null;
        const attack2 = member.attacks ? member.attacks[1] : null;
        const attack1Str = attack1 ? `${attack1.stars}⭐, ${attack1.destructionPercentage}%` : 'Not used';
        const attack2Str = attack2 ? `${attack2.stars}⭐, ${attack2.destructionPercentage}%` : 'Not used';

        report += `War #${wars.length - index} vs ${war.opponent?.name || 'Unknown'}:\n`;
        report += `Attack 1: ${attack1Str}\n`;
        report += `Attack 2: ${attack2Str}\n\n`;
      }
    });

    return { success: true, message: report };

  } catch (e) {
    console.error('Error fetching player war history:', e);
    return { error: true, message: `An unexpected error occurred: ${e.message}.` };
  }
}

// ------------------------- 🧮 Attendance Logs System -------------------------

// Background auto-update har 30 mins
setInterval(async () => {
  try {
    for (const [key, clanTag] of Object.entries(DB.userClans || {})) {
      if (!clanTag) continue;
      await updateAttendanceLogs(clanTag);
    }
  } catch (e) {
    console.error("Attendance auto-save error:", e.message);
  }
}, 30 * 60 * 1000); // 30 mins

async function updateAttendanceLogs(clanTag) {
  try {
    const liveWar = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
    if (!liveWar || liveWar.error || !liveWar.state) return;

    // ✅ agar preparation ya warEnded hai toh update skip karo
    if (liveWar.state === "preparation" || liveWar.state === "warEnded") {
      return; // DB me kuch naya save mat karo
    }

    // ✅ Clan info bhi fetch karo (name ke liye)
    const clanInfo = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);

    // Members list fetch
    const clanMembers = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/members`);
    if (!clanMembers || clanMembers.error || !clanMembers.items) return;

    const presentPlayers = new Set();

    // Past 1 month ke warlog check
    const warlog = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/warlog`);
    if (warlog && !warlog.error && Array.isArray(warlog.items)) {
      const oneMonthAgo = moment().subtract(1, "months");
      for (const war of warlog.items) {
        const warEndTime = moment(war.endTime);
        if (warEndTime.isBefore(oneMonthAgo)) break;

        if (war.clan?.members) {
          for (const m of war.clan.members) {
            if (m.attacks && m.attacks.length > 0) {
              presentPlayers.add(m.tag);
            }
          }
        }
      }
    }

    // Live war se bhi add karo
    if (liveWar.clan?.members) {
      for (const m of liveWar.clan.members) {
        if (m.attacks && m.attacks.length > 0) {
          presentPlayers.add(m.tag);
        }
      }
    }

    // Members ka join/leave compare
    const currentTags = clanMembers.items.map(m => m.tag);
    const oldRecord = DB.attendanceLogs?.[clanTag]?.lastMembers || [];

    const leaved = oldRecord.filter(t => !currentTags.includes(t));
    const joined = currentTags.filter(t => !oldRecord.includes(t));

    const total = clanMembers.items.length;
    let presentCount = 0;
    for (const m of clanMembers.items) {
      if (presentPlayers.has(m.tag)) presentCount++;
    }
    const absentCount = total - presentCount;

    // Attendance logs save
    DB.attendanceLogs = DB.attendanceLogs || {};
    DB.attendanceLogs[clanTag] = {
      lastUpdated: Date.now(),
      present: presentCount,
      absent: absentCount,
      total,
      percentPresent: ((presentCount / total) * 100).toFixed(1),
      percentAbsent: ((absentCount / total) * 100).toFixed(1),
      leaved: leaved || [],
      joined: joined || [],   // ✅ ab join bhi track hoga
      lastMembers: currentTags,
      clanName: clanInfo?.name || liveWar.clan?.name || "Unknown Clan"
    };

    saveDB();
  } catch (e) {
    console.error("updateAttendanceLogs failed:", e.message);
  }
}

// ------------------------- 📌 Attendance Command -------------------------
async function attendance({ sock, jid, args, sender, isGroup }) {
  try {
    const key = isGroup ? sender : jid;
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, {
        text: `✅ Usage: ${CONFIG.COMMAND_PREFIX}attendance #CLANTAG or set default with ${CONFIG.COMMAND_PREFIX}setclan #CLANTAG`
      });
    }

    const logs = DB.attendanceLogs?.[clanTag];
    if (!logs) {
      return await sock.sendMessage(jid, {
        text: "📭 Attendance logs not ready yet. They update automatically during wars."
      });
    }

    // ✅ Default time (from DB)
    let lastUpdatedText = moment(logs.lastUpdated).fromNow();

    // ✅ Fake time agar preparation/ended hai
    const liveWar = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
    if (liveWar?.state === "preparation" || liveWar?.state === "warEnded") {
      // Random 5–30 minutes fake
      const fakeMins = Math.floor(Math.random() * 26) + 5;
      lastUpdatedText = `${fakeMins} minutes ago`;
    }

    let rep = `🧮 *Attendance Report (Last Month)*\n`;
    rep += `🏰 Clan: ${logs.clanName}\n`;
    rep += `⏳ Last Updated: ${lastUpdatedText}\n`;
    rep += `👥 Current Members: ${logs.total}\n`;
    rep += `✅ Present: ${logs.present} (${logs.percentPresent}%)\n`;
    rep += `❌ Absent: ${logs.absent} (${logs.percentAbsent}%)\n`;

    // ✅ Joined members
    if (logs.joined?.length > 0) {
      rep += `\n🆕 Joined Clan: ${logs.joined.length} member(s)\n`;
      logs.joined.forEach(tag => {
        rep += ` + ${tag}\n`;
      });
    }

    // ✅ Leaved members
    if (logs.leaved?.length > 0) {
      rep += `\n👋 Left Clan: ${logs.leaved.length} member(s)\n`;
      logs.leaved.forEach(tag => {
        rep += ` - ${tag}\n`;
      });
    }

    await sock.sendMessage(jid, { text: rep });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error fetching attendance: ${e.message}` });
  }
};

// ------------------------- ⏱ Helper Functions -------------------------
function parseCoCTime(timeStr) {
  if (!timeStr) return null;
  if (/^\d{8}T\d{6}\.000Z$/.test(timeStr)) {
    const iso = timeStr.replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).000Z/,
      "$1-$2-$3T$4:$5:$6Z"
    );
    return new Date(iso);
  }
  return new Date(timeStr);
}

function formatTimeLeft(ms, extraSeconds = 17) {
  ms += extraSeconds * 1000; // extra buffer
  const h = Math.floor(ms / (1000*60*60));
  const m = Math.floor((ms % (1000*60*60)) / (1000*60));
  const s = Math.floor((ms % (1000*60)) / 1000);
  return `${h.toString().padStart(2,"0")}:${m.toString().padStart(2,"0")}:${s.toString().padStart(2,"0")}`;
}

// ------------------------- HELPERS -------------------------
function makeWarId(war) {
  return `${war.clan.tag}_${war.opponent?.tag || "unknown"}_${war.startTime || war.preparationStartTime || war.endTime || Date.now()}`;
}

function uniq(arr) {
  return [...new Set((arr||[]).filter(Boolean))];
}

// ------------------------- DB Init -------------------------
function ensureNotifyStore() {
  DB.lastWarNotificationSent = DB.lastWarNotificationSent || {};
  DB.userClans = DB.userClans || {};
  DB.authorisedGroups = DB.authorisedGroups || {};
  DB.groupMemberClans = DB.groupMemberClans || {};
  DB.authorisedUsers = DB.authorisedUsers || {};
}

// ------------------------- Cache for group participants -------------------------
const _groupParticipantsCache = new Map();
const _GROUP_CACHE_TTL = 60 * 1000; // 1 min

async function getGroupParticipantsCached(sock, groupJid) {
  const now = Date.now();
  const cached = _groupParticipantsCache.get(groupJid);
  if (cached && now - cached.ts < _GROUP_CACHE_TTL) return cached.participants;
  try {
    const meta = await sock.groupMetadata(groupJid);
    const participants = (meta?.participants || []).map(p => p?.id || p?.jid || p);
    _groupParticipantsCache.set(groupJid, { ts: now, participants });
    return participants;
  } catch(e) {
    console.error("⚠️ groupMetadata failed:", groupJid, e.message);
    return [];
  }
}

// ------------------------- Milestone Helper -------------------------
function pickLatestOverdueMilestone(now, endTime, allMilestones, baseKey) {
  // Order: 15m, 1h, 3h, 6h, 12h
  const ordered = [
    ...allMilestones.filter(m => m.m === 15),
    ...allMilestones.filter(m => m.h === 1),
    ...allMilestones.filter(m => m.h === 3),
    ...allMilestones.filter(m => m.h === 6),
    ...allMilestones.filter(m => m.h === 12),
  ];

  for (const m of ordered) {
    const notifyKey = `${baseKey}:${m.key}`;
    const triggerTime = endTime - (m.h ? m.h*3600*1000 : m.m*60*1000);
    if (now >= triggerTime && !DB.lastWarNotificationSent[notifyKey]) return { m, notifyKey };
  }
  return null;
}

// ------------------------- Resolve targets for a clan -------------------------
async function resolveTargetsForClan(sock, clanTag) {
  // 1️⃣ Direct DB.userClans mappings
  const explicitTargets = Object.entries(DB.userClans || {})
    .filter(([, data]) => {
      if (!data) return false;
      const tag = typeof data === "string" ? data : data?.clanTag;
      return tag?.toUpperCase().trim() === clanTag.toUpperCase().trim();
    })
    .map(([jid]) => jid);

  let groupTargets = uniq(explicitTargets.filter(t => t.endsWith("@g.us")));
  let userTargets  = uniq(explicitTargets.filter(t => !t.endsWith("@g.us")));
  
// 🔒 Remove unauthorized groups
groupTargets = groupTargets.filter(g => !!DB.authorisedGroups[g]);

  // 2️⃣ Groups with members having same clan (DB.groupMemberClans)
  for (const [gJid, membersMap] of Object.entries(DB.groupMemberClans || {})) {
    const hasClan = Object.values(membersMap || {}).some(tag => tag === clanTag);
    if (hasClan) groupTargets.push(gJid);
  }

  // 3️⃣ Fallback: authorised group scan
  const authorisedGroups = Object.keys(DB.authorisedGroups || {});
  for (const gJid of authorisedGroups) {
    if (groupTargets.includes(gJid)) continue;
    if (DB.groupMemberClans?.[gJid]) continue;

    const participants = await getGroupParticipantsCached(sock, gJid);
    let anyMemberHasClan = false;
    if (participants) {
      for (const p of participants) {
        const entry = DB.userClans?.[p];
        const tag = typeof entry === "string" ? entry : entry?.clanTag;
        if (tag === clanTag) { anyMemberHasClan = true; break; }
      }
    }
    if (anyMemberHasClan) groupTargets.push(gJid);
  }

  // 🔒 Remove unauthorized groups
  groupTargets = groupTargets.filter(g => !!DB.authorisedGroups[g]);

  return { groupTargets: uniq(groupTargets), userTargets: uniq(userTargets) };
}

// ------------------------- Handle War Notifications -------------------------
async function handleWarNotifications(sock) {
  try {
    ensureNotifyStore();

    const clanTags = Object.values(DB.userClans)
      .map(d => (typeof d === "string" ? d : d?.clanTag)?.toUpperCase()?.trim())
      .filter(Boolean);

    if (clanTags.length === 0) return console.log("⏩ No clans in DB.userClans");

    for (const clanTag of clanTags) {
      try {
        console.log("\n===============================");
        console.log("🔎 Checking clan:", clanTag);

        const war = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
        if (!war || war.error || !war.state) {
          console.log("⚠️ No valid war for", clanTag, war?.message || "");
          continue;
        }

        console.log("📡 War state:", war.state);

        const { groupTargets, userTargets } = await resolveTargetsForClan(sock, clanTag);
        if (!groupTargets.length && !userTargets.length) {
          console.log("⏩ No targets found for", clanTag);
          continue;
        }

        const baseKey = `${clanTag}:${war.preparationStartTime || war.startTime || "unknown"}`;

        // Preparation phase skip
        if (war.state === "preparation") {
          console.log("⏩ Skipping preparation for", clanTag);
          continue;
        }

        // In-War: milestone notifications
        if (war.state === "inWar") {
          const endTime = parseCoCTime(war.endTime)?.getTime();
          if (!endTime) { console.error("❌ Invalid war.endTime for", clanTag); continue; }

          const now = Date.now();
          const diffMs = endTime - now;
          if (diffMs <= 0) { console.log("⏩ War already ended"); continue; }

          const allMilestones = [
            { h: 12, key: "inwar12h" },
            { h: 6, key: "inwar6h" },
            { h: 3, key: "inwar3h" },
            { h: 1, key: "inwar1h" },
            { m: 15, key: "inwar15m" },
          ];

          const pick = pickLatestOverdueMilestone(now, endTime, allMilestones, baseKey);
          if (pick) {
            const timeLeftFormatted = formatTimeLeft(diffMs);
            console.log(`🚀 Sending ${pick.m.key} notification for ${clanTag}`);
            await sendWarNotificationToTargets(sock, war, userTargets, groupTargets, diffMs);
            DB.lastWarNotificationSent[pick.notifyKey] = now;
            if (typeof saveDB === "function") saveDB();
          } else {
            console.log("⏩ No pending milestones for", clanTag);
          }
        }

        // War Ended: one-time summary
        if (war.state === "warEnded") {
          const endedKey = `${baseKey}:ended`;
          if (!DB.lastWarNotificationSent[endedKey]) {
            console.log(`🏁 Sending warEnded for ${clanTag}`);

            const myStars = war.clan?.stars || 0;
            const oppStars = war.opponent?.stars || 0;
            const myDestruction = (war.clan?.destructionPercentage ?? 0).toFixed(2);
            const oppDestruction = (war.opponent?.destructionPercentage ?? 0).toFixed(2);

            let resultMsg = `🏁 *War Ended*\n`;
            if (myStars > oppStars) resultMsg += `Result: ${war.clan?.name} Wins!\n🎉 Congratulations we won ✌🏻\n`;
            else if (myStars < oppStars) resultMsg += `Result: ${war.opponent?.name} Wins!\n🥺 Better luck next time!\n`;
            else resultMsg += `Result: TIE! 🤝\n`;

            resultMsg += `\n${war.clan?.name}: ${myStars}⭐ (${myDestruction}%)\n`;
            resultMsg += `${war.opponent?.name}: ${oppStars}⭐ (${oppDestruction}%)`;

            await sendWarNotificationToTargets(sock, war, userTargets, groupTargets, null, resultMsg);
            DB.lastWarNotificationSent[endedKey] = Date.now();
            if (typeof saveDB === "function") saveDB();
          } else console.log("⏩ War ended notification already sent for", clanTag);
        }

      } catch(err) { console.error("❌ notify error for", clanTag, err.message || err); }
    }

  } catch(err) { console.error("❌ handleWarNotifications failed:", err.message || err); }
}

// ------------------------- ⚔️ Send War Notification -------------------------
async function sendWarNotificationToTargets(sock, war, userTargets = [], groupTargets = [], timeLeft = null, overrideMsg = null) {
  // 17 seconds extra buffer add kar diya
  const extraMs = 17 * 1000;
  if (timeLeft !== null) timeLeft += extraMs;

  const defaultMsg = timeLeft !== null
    ? (
      `⚔️ *War Live Update*\n` +
      `War ends in: ${formatTimeLeft(timeLeft)}\n` +
      `⚠️ Do your attacks!\n` +
      `Clan: ${war.clan?.name}\n` +
      `Vs: ${war.opponent?.name}\n` +
      `Attacks: ${war.clan?.attacks || 0}\n` +
      `Stars: ${war.clan?.stars || 0} - ${war.opponent?.stars || 0}\n` +
      `Destruction: ${(war.clan?.destructionPercentage ?? 0).toFixed(2)}% - ${(war.opponent?.destructionPercentage ?? 0).toFixed(2)}%`
    )
    : (overrideMsg || '⚔️ War Update');

  const msgToSend = overrideMsg || defaultMsg;

  console.log("📤 Sending notification:\n", msgToSend);

  // --- Groups ---
  const sentGroups = new Set();
  for (const g of uniq(groupTargets)) {
    if (sentGroups.has(g)) continue;
    try {
      console.log("➡️ Sending to group:", g);
      await sock.sendMessage(g, { text: msgToSend }).catch(() => {});
      sentGroups.add(g);
    } catch (e) { console.error("⚠️ Group send error:", g, e.message); }
  }

  // --- Users (owner + authorised) ---
  const ownerJid = CONFIG.OWNER_JID?.trim();
  for (const u of uniq(userTargets)) {
    try {
      const isOwner = ownerJid && u === ownerJid;
      const isUserAuth = !!DB.authorisedUsers?.[u];
      if (isOwner || isUserAuth) {
        console.log("➡️ Sending to user:", u);
        await sock.sendMessage(u, { text: msgToSend }).catch(() => {});
      } else {
        console.log("❌ Skipping DM for", u, "(not authorised)");
      }
    } catch (e) { console.error("⚠️ User send error:", u, e.message); }
  }
}

// ------------------------- Scheduler -------------------------
setInterval(() => handleWarNotifications(sock), 30 * 1000);

// ------------------------- 🧠 AI (Groq placeholder) -------------------------
async function groqChat(messages) {
  try {
    if (!CONFIG.GROQ_API_KEY) {
      return '🤖 (AI disabled) GROQ_API_KEY not set.';
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-70b-8192", // Tum model change kar sakte ho
        messages: messages,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || "❌ AI reply not available.";
  } catch (e) {
    console.error("Groq Chat Error:", e);
    return `❌ AI error: ${e.message}`;
  }
}

// ------------------------- 🧩 HANDLERS (Commands) -------------------------
const HANDLERS = {
  // ==================== COC Extra Commands ====================
  liveattack: async ({ sock, jid, args, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // group me per-user ka clanTag
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { text: "❌ Clan tag not set. Use setclan command first." });
    }

    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);

    if (!data || data.state !== "inWar") {
      return await sock.sendMessage(jid, { text: "📭 No live war is currently active." });
    }

    const myDestruction = (data.clan?.destructionPercentage || 0).toFixed(2);
    const oppDestruction = (data.opponent?.destructionPercentage || 0).toFixed(2);

    await sock.sendMessage(jid, { 
      text: `🔥 *Live War Update*\n` +
            `🏰 Clan: ${data.clan?.name}\n` +
            `⚔️ Opponent: ${data.opponent?.name}\n\n` +
            `📊 Attacks Used: ${data.clan?.attacks || 0}/${data.teamSize * 2}\n` +
            `⭐ Stars: ${data.clan?.stars || 0} - ${data.opponent?.stars || 0}\n` +
            `💥 Destruction: ${myDestruction}% - ${oppDestruction}%`
    });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

capitalraids: async ({ sock, jid, args, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // group me per-user ka clanTag
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: "❌ Clan tag not set. Use setclan command first." 
      });
    }

    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/capitalraidseasons`);

    if (!data?.items?.length) {
      return await sock.sendMessage(jid, { text: "📭 No capital raid data found." });
    }

    const latest = data.items[0];
    const msg = `🏰 *Capital Raids (Latest)*\n` +
      `📅 Season: ${latest.startTime?.slice(0,10)} - ${latest.endTime?.slice(0,10)}\n` +
      `⭐ Total Attacks: ${latest.totalAttacks || 0}\n` +
      `🔥 Raids Completed: ${latest.raidsCompleted || 0}\n` +
      `🏆 Offensive Reward: ${latest.offensiveReward || 0}\n` +
      `🛡️ Defensive Reward: ${latest.defensiveReward || 0}`;

    await sock.sendMessage(jid, { text: msg });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  clancapital: async ({ sock, jid, args, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // group me per-user ke liye
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: `❌ Clan tag not set. Use *${CONFIG.COMMAND_PREFIX}setclan #CLANTAG* first.` 
      });
    }

    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);
    if (!data?.clanCapital) {
      return await sock.sendMessage(jid, { text: "❌ Unable to fetch clan capital info." });
    }

    const msg = `🏰 *Clan Capital Info*\n` +
                `📌 Clan: ${data.name} (${data.tag})\n` +
                `🏯 Capital Hall Level: ${data.clanCapital.capitalHallLevel}`;

    await sock.sendMessage(jid, { text: msg });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  donations: async ({ sock, jid, args, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // group me per-user system
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: `❌ Clan tag not set. Use *${CONFIG.COMMAND_PREFIX}setclan #CLANTAG* first.` 
      });
    }

    // ✅ Fetch clan info (to get name + tag)
    const clanInfo = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);

    // ✅ Fetch clan members
    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/members`);
    if (!data?.items) {
      return await sock.sendMessage(jid, { text: "❌ Unable to fetch clan members donations." });
    }

    let msg = `📦 *Donations Report*\n🏰 Clan: ${clanInfo.name} (${clanInfo.tag})\n\n`;
    msg += data.items
      .map(m => `👤 ${m.name}: 📤 ${m.donations} | 📥 ${m.donationsReceived}`)
      .join("\n");

    await sock.sendMessage(jid, { text: msg });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  goldpass: async ({ sock, jid }) => {
  try {
    const data = await cocFetch(`/goldpass/seasons/current`);

    if (!data?.startTime || !data?.endTime) {
      return await sock.sendMessage(jid, { text: "❌ Unable to fetch Gold Pass season info." });
    }

    // ✅ Convert API date format to readable date
    const formatDate = (cocDate) => {
      const year = cocDate.slice(0, 4);
      const month = cocDate.slice(4, 6);
      const day = cocDate.slice(6, 8);
      return new Date(`${year}-${month}-${day}`).toDateString(); 
      // Example: "Fri Aug 01 2025"
    };

    const msg = `🏆 *Gold Pass Season Info*\n` +
                `📅 Start: ${formatDate(data.startTime)}\n` +
                `📅 End: ${formatDate(data.endTime)}`;

    await sock.sendMessage(jid, { text: msg });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  checkmembers: async ({ sock, jid, args, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // group me per-user
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: `❌ Clan tag not set. Use *${CONFIG.COMMAND_PREFIX}setclan #CLANTAG* first.` 
      });
    }

    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/members`);
    if (!data?.items) {
      return await sock.sendMessage(jid, { text: "❌ Unable to fetch clan members." });
    }

    let msg = `👥 *Clan Members List*\n`;
    msg += `🏰 Clan: ${data.name} (${data.tag})\n\n`;
    msg += data.items.map((m, i) => `${i + 1}. ${m.name} (${m.tag})`).join("\n");

    await sock.sendMessage(jid, { text: msg });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},
 
  warleagues: async ({ sock, jid }) => {
    try {
      const data = await cocFetch(`/warleagues`);
      const list = data.items.map(l => `${l.name} (${l.id})`).join("\n");
      await sock.sendMessage(jid, { text: `⚔ War Leagues:\n${list}` });
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
    }
  },
  
  leagues: async ({ sock, jid }) => {
  try {
    const data = await cocFetch(`/leagues`);

    if (!data?.items?.length) {
      return await sock.sendMessage(jid, { text: "📭 No league data found." });
    }

    const list = data.items
      .map(l => `${l.name} (${l.id})`)
      .join("\n");

    await sock.sendMessage(jid, { text: `🏅 Leagues:\n${list}` });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  topclans: async ({ sock, jid, args }) => {
    try {
      const locationId = args[0] || 32000006;
      const data = await cocFetch(`/locations/${locationId}/rankings/clans`);
      if (!data || !Array.isArray(data.items)) {
        return await sock.sendMessage(jid, { text: "❌ No clan ranking data found." });
      }
      const list = data.items
        .slice(0, 50)
        .map(c => `${c.name} (Lvl ${c.clanLevel}) - ${c.clanPoints} pts`)
        .join("\n");
      await sock.sendMessage(jid, { text: `🏆 Top Clans:\n${list}` });
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
    }
  },  // 👈 IMPORTANT comma

  topplayers: async ({ sock, jid, args }) => {   // ✅ ab sahi jagah hai
    try {
      const locationId = args[0] || 32000006;
      const data = await cocFetch(`/locations/${locationId}/rankings/players`);
      if (!data || !Array.isArray(data.items)) {
        return await sock.sendMessage(jid, { text: "❌ No player ranking data found." });
      }
      const list = data.items
        .slice(0, 50)
        .map(p => `${p.name} (Lvl ${p.expLevel}) - ${p.trophies} 🏆`)
        .join("\n");
      await sock.sendMessage(jid, { text: `🏅 Top Players:\n${list}` });
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
    }
  },   // 👈 yahan comma lagana zaroori hai agar aur commands baaki ho

locations: async ({ sock, jid }) => {
  try {
    const data = await cocFetch(`/locations`);
    if (!data || !data.items) {
      return await sock.sendMessage(jid, { text: "📭 No locations data found." });
    }

    const list = data.items
      .slice(0, 50)
      .map(l => `${l.name} (ID: ${l.id})`)
      .join("\n");

    await sock.sendMessage(jid, { text: `🌍 Locations:\n${list}` });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

clanrankings: async ({ sock, jid, args }) => {
  try {
    const locationId = args[0] || 32000006;
    const data = await cocFetch(`/locations/${locationId}/rankings/clans`);

    if (!data || !Array.isArray(data.items)) {
      return await sock.sendMessage(jid, { text: "❌ No clan ranking data found." });
    }

    const list = data.items
      .slice(0, 50)
      .map(c => `${c.name} (Lvl ${c.clanLevel}) - ${c.clanPoints} pts`)
      .join("\n");

    await sock.sendMessage(jid, { text: `📊 Clan Rankings:\n${list}` });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  playerrankings: async ({ sock, jid, args }) => {
  try {
    const locationId = args[0] || "global";  // Default to global if nothing provided
    const data = await cocFetch(`/locations/${locationId}/rankings/players`);

    if (!data?.items?.length) {
      return await sock.sendMessage(jid, { 
        text: `❌ No player ranking data found for this region (${locationId}).\nTry with "global" or another valid location ID.`
      });
    }

    const list = data.items
      .slice(0, 50)
      .map((p, i) => `${i + 1}. ${p.name} (Lvl ${p.expLevel}) - ${p.trophies} 🏆`)
      .join("\n");

    await sock.sendMessage(jid, { text: `🏅 Player Rankings:\n${list}` });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
},

  // ------------ Free Commands ------------
  start: async ({ sock, jid }) => {
    await sock.sendMessage(jid, {
      text: `Hey there! I'm *${CONFIG.BOT_NAME}* 🤖\n\nType *${CONFIG.COMMAND_PREFIX}help* to see what I can do!`
    });
  },

  help: async ({ sock, jid }) => {
    const helpMsg = `Hey there! I'm *${CONFIG.BOT_NAME}* 🤖

*Free Commands (For Everyone):*
start - Show this welcome msg 👋
help - Show this message 📚
botinfo - Get information about the bot 🤖
authstatus - Check your authorization status 🔐
info - Get your own user info ℹ️
qr - Get the bot's payment QR code image 🖼️
enteraimode - Activate AI mode 🧠
exitaimode - Deactivate AI mode 📴
*Misc Info:*
📸 Instagram Reels - Send link to download reel

*CoC Commands (Authorised Users/Groups):*
claninfo [optional #CLANTAG] 🏰
player #PLAYERTAG 👤
playerstats #PLAYERTAG 📊
liveattack [track your clan war stats] ⚡️
warlog [get your 10 last clan war details] 📜
cminfo or cminfo <member-number> - [see clan members, details and war history] 🪖
attendance [get your clan attendance details] ✅
capitalraids [get your clan capitalraids deatils] 🏦
clancapital [get your clan clancapital details] 🏛️
donations [get your clan donations details] 🎁
goldpass 🏆
locations 🗺️
leagues 🏅
warleagues 🛡️
topclans [optional location ID] 🥇
topplayers [optional location ID] 👑
clanrankings [optional location ID] 📈
playerrankings [optional location ID] 📊
setclan #CLANTAG [set your current clan] 🏠
removeclan [remove your current setclan] ❌
whenwar [check war status for your clan] ⏳

*Admin Commands (for owner):*
add [user_jid] ➕
remove [user_jid] ➖
addgroup ➕
removegroup ➖

`;
    await sock.sendMessage(jid, { text: helpMsg });
  },

  botinfo: async ({ sock, jid }) => {
  try {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const msg = `🤖 *${CONFIG.BOT_NAME}*\nVersion: 1.0\nOwner Name : Saad Khan \nOwner social handle : https://www.instagram.com/_saad__.04?igsh=MWZsa2E3OHFjcTc3OA==\nUptime: ${hours}h ${minutes}m ${seconds}s`;

    await sock.sendMessage(jid, {
      image: { url: "./OWNER.JPG" }, // OWNER.JPG bot ke same folder me hona chahiye
      caption: msg
    });
  } catch (err) {
    console.error("botinfo command error:", err);
    await sock.sendMessage(jid, { text: "❌ Error fetching bot info." });
  }
},

  authstatus: async ({ sock, jid, isOwner, isAuthorizedForGroup, isAuthorizedForDM }) => {
  const statusIcon = (status) => (status ? "✅" : "❌");
  const msg =
`╭────────────────────────────╮
│  🔐 *AUTHORIZATION STATUS*  │
├────────────────────────────┤
│ 👑 *Owner*         : ${statusIcon(isOwner)}
│ 👥 *Group Access*  : ${statusIcon(isAuthorizedForGroup)}
│ 💬 *Direct Access* : ${statusIcon(isAuthorizedForDM)}
╰────────────────────────────╯`;

  await sock.sendMessage(jid, { text: msg });
}

  HANDLERS.info = async ({ sock, jid, sender, msg }) => {
    try {
        const name = msg.pushName || sender.split("@")[0];
        const number = sender.split("@")[0];

        // Profile Picture
        let profilePic = null;
        try {
            profilePic = await sock.profilePictureUrl(sender, "image");
        } catch {
            profilePic = null;
        }

        // Battery Info
        let batteryInfo = "Not available";
        if (sock?.ws?.battery) {
            batteryInfo = `${sock.ws.battery}% ${sock.ws.plugged ? "(Charging)" : ""}`;
        }

        // Message text
        let infoText = `ℹ️ *Your Info:*\n`;
        infoText += `Name: ${name}\n`;
        infoText += `Number: ${number}\n`;
        infoText += `JID: ${sender}\n`;
        infoText += `Battery: ${batteryInfo}`;

        if (profilePic) {
            await sock.sendMessage(jid, {
                image: { url: profilePic },
                caption: infoText
            });
        } else {
            await sock.sendMessage(jid, { text: infoText });
        }
    } catch (err) {
        console.error("Info command error:", err);
        await sock.sendMessage(jid, { text: "❌ Info fetch karne me problem hui." });
    }
};

  HANDLERS.qr = async ({ sock, jid }) => {
  const qrPath = path.join(__dirname, 'payment_qr.png');
  if (fs.existsSync(qrPath)) {
    await sock.sendMessage(jid, {
      image: { url: qrPath },
      caption: '📌 Scan this QR to make a payment.'
    });
  } else {
    await sock.sendMessage(jid, { text: '❌ QR Code not found.' });
  }
};

  // AI Mode ON
HANDLERS.enteraimode = async ({ sock, jid, sender }) => {
    if (DB.aiModeUsers[sender]) {
        return await sock.sendMessage(jid, { text: '❌ You are already in AI mode!' });
    }
    DB.aiModeUsers[sender] = true;
    saveDB();
    await sock.sendMessage(jid, { text: '✅ AI mode activated. Type freely; send exitaimode to stop.' });
};

// AI Mode OFF
HANDLERS.exitaimode = async ({ sock, jid, sender }) => {
    if (!DB.aiModeUsers[sender]) {
        return await sock.sendMessage(jid, { text: '❌ You are not in AI mode!' });
    }
    delete DB.aiModeUsers[sender];
    delete DB.aiChatHistory[sender];
    saveDB();
    await sock.sendMessage(jid, { text: '✅ AI mode deactivated.' });
};

  // ------------ Admin Commands ------------
  HANDLERS.add = async ({ sock, jid, args, isOwner }) => {
    if (!isOwner) return await sock.sendMessage(jid, { text: '❌ You are not the owner of the bot.' });
    const userJid = args[0] ? jidNormalizedUser(args[0]) : null;
    if (!userJid) return await sock.sendMessage(jid, { text: `📖 Usage: ${CONFIG.COMMAND_PREFIX}add 91XXXXXXXXXX@s.whatsapp.net` });
    DB.authorisedUsers[userJid] = true;
    saveDB();
    await sock.sendMessage(jid, { text: `✅ User ${userJid} authorised.` });
  };

  HANDLERS.remove = async ({ sock, jid, args, isOwner }) => {
    if (!isOwner) return await sock.sendMessage(jid, { text: '❌ You are not the owner of the bot.' });
    const userJid = args[0] ? jidNormalizedUser(args[0]) : null;
    if (!userJid) return await sock.sendMessage(jid, { text: `📖 Usage: ${CONFIG.COMMAND_PREFIX}remove 91XXXXXXXXXX@s.whatsapp.net` });
    delete DB.authorisedUsers[userJid];
    saveDB();
    await sock.sendMessage(jid, { text: `✅ User ${userJid} removed from authorised list.` });
  };

  HANDLERS.addgroup = async ({ sock, jid, isOwner }) => {
    if (!isOwner) return await sock.sendMessage(jid, { text: '❌ You are not the owner of the bot.' });
    DB.authorisedGroups[jid] = true;
    saveDB();
    await sock.sendMessage(jid, { text: `✅ Group authorised.` });
  };

  HANDLERS.removegroup = async ({ sock, jid, isOwner }) => {
    if (!isOwner) return await sock.sendMessage(jid, { text: '❌ You are not the owner of the bot.' });
    delete DB.authorisedGroups[jid];
    saveDB();
    await sock.sendMessage(jid, { text: `✅ Group removed from authorised list.` });
  };

  // ------------ Clash of Clans Commands ------------
// ------------------------- SETCLAN HANDLER (safe) -------------------------
HANDLERS.setclan = async function ({ sock, jid, sender, args }) {
  try {
    if (!args?.[0]) {
      return await sock.sendMessage(jid, { 
        text: "❌ Please provide a clan tag.\nExample: setclan #CLANTAG" 
      });
    }

    let clanTag = args[0].toUpperCase();
    if (!clanTag.startsWith("#")) clanTag = `#${clanTag}`;

    // Validate clan from CoC API
    const clanData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);
    if (!clanData?.name) {
      return await sock.sendMessage(jid, { text: "❌ Invalid clan tag or clan not found." });
    }

    // choose the reliable function: prefer globalThis alias then local
    const fn = (typeof globalThis !== 'undefined' && typeof globalThis.setClan === 'function')
      ? globalThis.setClan
      : (typeof setClan === 'function' ? setClan : null);

    if (!fn) {
      console.error("setClan function not found at runtime. globalThis.setClan:", typeof globalThis !== 'undefined' ? typeof globalThis.setClan : 'undefined', "local setClan:", typeof setClan);
      return await sock.sendMessage(jid, { text: "❌ Internal error: set function missing. Owner, check bot logs." });
    }

    // call existing setter (may return a message)
    const msg = await fn(sender, clanTag);

    // ---- NEW: maintain DB mappings ----
    try {
      // ensure structures exist
      DB.userClans = DB.userClans || {};
      DB.groupMemberClans = DB.groupMemberClans || {};

      // save per-user mapping (so DM/explicit mapping continues to work)
      DB.userClans[sender] = clanTag;

      // if command was used inside a group chat, also map member -> clan under group
      // jid is destination; if it's a group JID (endsWith @g.us) then record mapping
      if (jid && typeof jid === 'string' && jid.endsWith('@g.us')) {
        // memberJid: use sender as fallback (common). If you later expose `msg`, prefer msg.key.participant.
        const memberJid = sender; // or: (msg?.key?.participant || sender)
        DB.groupMemberClans[jid] = DB.groupMemberClans[jid] || {};
        DB.groupMemberClans[jid][memberJid] = clanTag;
      }

      if (typeof saveDB === 'function') saveDB();
    } catch (e) {
      console.error("Failed to update DB.groupMemberClans in setclan:", e && e.message ? e.message : e);
    }

    return await sock.sendMessage(jid, {
      text: ` ${msg}\n*Clan:* ${clanData.name} (${clanData.tag})`
    });

  } catch (err) {
    console.error("setclan error:", err);
    return await sock.sendMessage(jid, { text: "❌ Error setting clan." });
  }
};

// ------------------------- REMOVECLAN HANDLER (safe) -------------------------
HANDLERS.removeclan = async function ({ sock, jid, sender }) {
  try {
    // Prefer a guaranteed global function if available
    const fn = (typeof globalThis !== 'undefined' && typeof globalThis.removeClan === 'function')
      ? globalThis.removeClan
      : (typeof removeClan === 'function' ? removeClan : null);

    if (!fn) {
      console.error("removeClan function not found at runtime. globalThis.removeClan:", typeof globalThis !== 'undefined' ? typeof globalThis.removeClan : 'undefined', "local removeClan:", typeof removeClan);
      return await sock.sendMessage(jid, { text: "❌ Internal error: remove function missing. Ask the bot owner to check logs." });
    }

    // call existing remover (may return a message)
    const msg = await fn(sender);

    // ---- NEW: clean up DB mappings ----
    try {
      // remove per-user mapping
      if (DB.userClans && DB.userClans[sender]) {
        delete DB.userClans[sender];
      }

      // if used inside a group, remove that user's entry from groupMemberClans
      if (jid && typeof jid === 'string' && jid.endsWith('@g.us')) {
        const memberJid = sender; // or (msg?.key?.participant || sender) if available
        if (DB.groupMemberClans && DB.groupMemberClans[jid]) {
          delete DB.groupMemberClans[jid][memberJid];
          // clean up empty group map
          if (Object.keys(DB.groupMemberClans[jid] || {}).length === 0) {
            delete DB.groupMemberClans[jid];
          }
        }
      }

      if (typeof saveDB === 'function') saveDB();
    } catch (e) {
      console.error("Failed cleaning DB.groupMemberClans in removeclan:", e && e.message ? e.message : e);
    }

    return await sock.sendMessage(jid, { text: msg });
  } catch (err) {
    console.error("removeclan error:", err);
    return await sock.sendMessage(jid, { text: "❌ Error removing clan." });
  }
};

  HANDLERS.claninfo = async ({ sock, jid, args, sender, isGroup }) => {
  try {
    // 🔑 Har user ka apna key (DM me sender, group me bhi user alag hoga)
    const key = sender;  

    // 📌 Agar user ne args diya toh uska use karo warna DB se le lo
    const clanTag = args[0] || DB.userClans[key];
    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: `🏰 Usage: ${CONFIG.COMMAND_PREFIX}claninfo #CLANTAG\nOr set default with ${CONFIG.COMMAND_PREFIX}setclan #CLANTAG` 
      });
    }

    // 📡 Clash of Clans API call
    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);
    if (data.error) {
      return await sock.sendMessage(jid, { 
        text: `❌ Error: ${data.message || 'Unknown error'}` 
      });
    }

    // ✅ Reply with clan info
    await sock.sendMessage(jid, {
      text: `🏰 *Clan Info:*\n\n` +
            `📛 Name: ${data.name}\n` +
            `🏷️ Tag: ${data.tag}\n` +
            `👥 Members: ${data.members}/50\n` +
            `📈 Level: ${data.clanLevel}`
    });
  } catch (e) {
    console.error("claninfo error:", e.message);
    await sock.sendMessage(jid, { text: "⚠️ Failed to fetch clan info. Try again later." });
  }
};

  HANDLERS.player = async ({ sock, jid, args }) => {
    const tag = args[0];
    if (!tag || !tag.startsWith('#')) return await sock.sendMessage(jid, { text: `📖 Usage: ${CONFIG.COMMAND_PREFIX}player #PLAYERTAG` });
    const data = await cocFetch(`/players/${encodeURIComponent(tag)}`);
    if (data.error) return await sock.sendMessage(jid, { text: `❌ Error: ${data.message || 'Unknown error'}` });
    await sock.sendMessage(jid, {
      text: `👤 *Player Info*\nName: ${data.name}\nTH: ${data.townHallLevel}\nLevel: ${data.expLevel}\nTrophies: ${data.trophies}`
    });
  };

  HANDLERS.playerstats = async ({ sock, jid, args }) => {
    const tag = args[0];
    if (!tag || !tag.startsWith('#')) return await sock.sendMessage(jid, { text: `📖 Usage: ${CONFIG.COMMAND_PREFIX}playerstats #PLAYERTAG` });
    const data = await cocFetch(`/players/${encodeURIComponent(tag)}`);
    if (data.error) return await sock.sendMessage(jid, { text: `❌ Error: ${data.message || 'Unknown error'}` });
    await sock.sendMessage(jid, {
      text: `📊 *Player Stats*\nName: ${data.name}\nWar Stars: ${data.warStars}\nDonations: ${data.donations}\nReceived: ${data.donationsReceived}`
    });
  };

  HANDLERS.clanmembers = async ({ sock, jid, args, sender, isGroup }) => {
    const key = isGroup ? jid : sender;
    const clanTag = args[0] || DB.userClans[key];
    if (!clanTag) return await sock.sendMessage(jid, { text: `👥 Usage: ${CONFIG.COMMAND_PREFIX}clanmembers #CLANTAG or set default with ${CONFIG.COMMAND_PREFIX}setclan #CLANTAG` });
    const data = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/members`);
    if (data.error) return await sock.sendMessage(jid, { text: `❌ Error: ${data.message || 'Unknown error'}` });
    const lines = data.items.map((m, i) => `${i + 1}. ${m.name} (${m.tag})`);
    await sock.sendMessage(jid, { text: `👥 *Members*\n` + lines.join('\n') });
  };

  HANDLERS.cm = async function (ctx) {
  // ctx = { sock, jid, args, sender, isGroup, ... }
  // Directly reuse warlogs <player_no> handler
  if (!ctx.args[0] || isNaN(ctx.args[0])) {
    return await ctx.sock.sendMessage(ctx.jid, { text: "❌ Usage: cm <player_no>" });
  }

  // Call warlogs handler with same parameters
  return await HANDLERS.warlogs(ctx);
};

  HANDLERS.warlog = async ({ sock, jid, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // per-user setclan support
    const clanTag = DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: `❌ Clan tag not set. Use ${CONFIG.COMMAND_PREFIX}setclan #CLANTAG first.` 
      });
    }

    // Fetch last war logs
    const warLogData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/warlog`);

    if (!warLogData || !Array.isArray(warLogData.items) || warLogData.items.length === 0) {
      return await sock.sendMessage(jid, { 
        text: "❌ No war log data found for this clan." 
      });
    }

    // Format last 10 wars
    const wars = warLogData.items.slice(0, 10).map((w, i) => {
      const opponentName = w.opponent?.name || "Unknown";
      const result = w.result || "unknown";
      const clanStars = w.clan?.stars ?? 0;
      const opponentStars = w.opponent?.stars ?? 0;
      return `*No.${i + 1}* ⚔️ vs ${opponentName} | Result: ${result} (${clanStars}⭐ : ${opponentStars}⭐)`;
    }).join("\n");

    const msg = `📜 *Last 10 War Log:*\n🏰 Clan: ${warLogData.items[0]?.clan?.name || "Unknown"}\n\n${wars}`;
    await sock.sendMessage(jid, { text: msg });

  } catch (e) {
    await sock.sendMessage(jid, { 
      text: `❌ Error fetching war logs: ${e.message}` 
    });
  }
};

  HANDLERS.cminfo = async function ({ sock, jid, args, sender, isGroup }) {
  try {

// Get clan tag after auth check
const key = isGroup ? sender : jid;
const clanTag = DB.userClans[key];
if (!clanTag) {
  return await sock.sendMessage(jid, { 
    text: "❌ Clan tag not set. Use setclan first." 
  });
}

    // ✅ 1. Only `cminfo` → show clan members + attack usage
if (!args[0]) {
  const clanData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);
  const warData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);

  // Default to notInWar if undefined
  const warState = warData?.state || "notInWar";

  console.log("=== DEBUG START ===");
  console.log("[DEBUG] Raw warData:", JSON.stringify(warData, null, 2));
  console.log("[DEBUG] warState:", warState);
  console.log("[DEBUG] Total members:", clanData.memberList.length);

  let msg = `🏰 *Clan Members for ${clanData.name} (${clanData.tag}):*\n\n`;

  for (const [i, m] of clanData.memberList.entries()) {
    console.log(`\n[DEBUG] Checking player: ${m.name} (${m.tag})`);

    msg += `${i + 1}. ${m.name} ${m.tag}\n`;

    let status = "";
    const wm = warData?.clan?.members?.find(x => x.tag === m.tag);

    if (warState === "inWar") {
      if (!wm) {
        console.log("[DEBUG] Player not in current war members.");
        status = "(not in current war)";
      } else {
        const used = wm?.attacks?.length || 0;
        console.log(`[DEBUG] Attacks used (live war): ${used}`);
        status =
          used === 0 ? "(unused attacks in current war)" :
          used === 1 ? "(used 1 attack in current war)" :
          "(used 2 attacks in current war)";
      }
    } 
    
    else if (warState === "warEnded" || warState === "preparation") {
      const logs = DB.playerWarLogs?.[m.tag] || [];
      console.log(`[DEBUG] Logs found in DB: ${logs.length}`);

      if (!logs.length) {
        console.log("[DEBUG] Fetching last war from API...");
        const warLogsApi = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/warlog?limit=1`);

        if (warLogsApi?.reason === "accessDenied") {
          // ✅ private clan error
          status = "(clan is private can't show stats)";
        } else {
          console.log("[DEBUG] Raw warLogsApi:", JSON.stringify(warLogsApi, null, 2));
          const lastWar = warLogsApi?.items?.[0];
          const playerInLastWar = lastWar?.clan?.members?.find(x => x.tag === m.tag);

          if (!playerInLastWar) {
            console.log("[DEBUG] Player NOT in last war (API check).");
            status = "(not in last war)";
          } else {
            // ✅ API warlog attack analysis
            const attacks = playerInLastWar?.attacks || [];
            const usedCount = attacks.filter(a => a.destructionPercentage > 0).length;
            const unusedCount = 2 - usedCount;

            if (usedCount === 0 && unusedCount === 2) {
              status = "(unused attacks in last war)";
            } else if (usedCount === 1) {
              status = "(used 1 attack in last war)";
            } else if (usedCount === 2) {
              status = "(used 2 attacks in last war)";
            } else {
              status = "(not in last war)";
            }
          }
        }
      } else {
        // ✅ DB logs analysis
        const lastLogs = logs.filter(l => !l.isFromLive).slice(-2);
        console.log(`[DEBUG] Last war logs found (DB): ${lastLogs.length}`);

        if (!lastLogs.length) {
          status = "(not in last war)";
        } else {
          const usedCount = lastLogs.filter(l => l.destructionPercentage > 0).length;
          const unusedCount = 2 - usedCount;

          if (usedCount === 0 && unusedCount === 2) {
            status = "(unused attacks in last war)";
          } else if (usedCount === 1) {
            status = "(used 1 attack in last war)";
          } else if (usedCount === 2) {
            status = "(used 2 attacks in last war)";
          } else {
            status = "(can't show last stats)";
          }
        }
      }
    } 
    
    else {
      console.log("[DEBUG] War state = else (no war?)");
      status = "(no active war right now)";
    }

    msg += status + "\n\n";
  }

  console.log("=== DEBUG END ===");
  return await sock.sendMessage(jid, { text: msg });
}

    // ✅ 2. `cminfo <player_no>` → specific player details
if (!isNaN(args[0])) {
  const playerNo = parseInt(args[0], 10);
  const clanData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);
  const warData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
  const warState = warData?.state;
  const player = clanData.memberList[playerNo - 1];

  if (!player) {
    return await sock.sendMessage(jid, { text: "❌ Invalid player number." });
  }

  let warLogs = (DB.playerWarLogs?.[player.tag] || [])
  .filter(l => !l.isFromLive)   // ✅ only finalized war logs
  .slice(-10)
  .reverse();
  let msg = `📌 *Player War Details for ${player.name}*\n\n`;

  // 🔥 Current live war
  if (warState === "inWar") {
    msg += `🏰 Clan: ${warData?.clan?.name || "?"} (${warData?.clan?.tag || "?"}) vs ${warData?.opponent?.name || "?"} (${warData?.opponent?.tag || "?"})\n\n`;
    const wm = warData.clan.members.find(x => x.tag === player.tag);
    if (wm) {
      msg += `🔥 *Current Live War Attacks:*\n`;
      msg += wm.attacks?.[0]
        ? `Attack 1 → vs ${warData.opponent.members.find(o => o.tag === wm.attacks[0].defenderTag)?.name || "Unknown"} → ${wm.attacks[0].destructionPercentage}% (${wm.attacks[0].stars}⭐)\n`
        : `Attack 1 → Unused\n`;
      msg += wm.attacks?.[1]
        ? `Attack 2 → vs ${warData.opponent.members.find(o => o.tag === wm.attacks[1].defenderTag)?.name || "Unknown"} → ${wm.attacks[1].destructionPercentage}% (${wm.attacks[1].stars}⭐)\n`
        : `Attack 2 → Unused\n`;
      msg += "\n";
    } else {
      msg += `🔥 Live War: [ leader hasn't selected this member to be in war ]\n\n`;
    }
  }

  // 🔥 After war ended / preparation
  else if (warState === "warEnded" || warState === "preparation") {
    const logs = DB.playerWarLogs?.[player.tag] || [];
    const lastLogs = logs.filter(l => !l.isFromLive).slice(-2);

    if (!logs.length) {
      msg += ` 🥲 The player record is unavailable because he wasn't in last war\n\n`;
    } else if (lastLogs.length === 0) {
      msg += `1. The user wasn't attacked in last war\n\n`;
    }
    // ❌ no "Last War Attacks" section here
  }

  // 📜 War History (always show)
  if (warLogs.length) {
    msg += `📜 *War History:*\n`;
    let grouped = {};
    for (const log of warLogs) {
      const key = `${log.myClan} ${log.myClanTag || ""} vs ${log.oppClan} ${log.oppClanTag || ""}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(log);
    }
    let idx = 1;
    for (const [warKey, logs] of Object.entries(grouped)) {
      const sample = logs[0]; // ek hi war ke sab attacks same clan vs opp honge

      const myClanTag = sample.clanTag ? ` (${sample.clanTag})` : "";
      const oppClanTag = sample.oppClanTag ? ` (${sample.oppClanTag})` : "";

      msg += `*No*.${idx++} 🏰 ${sample.myClan}${myClanTag} vs ${sample.oppClan}${oppClanTag}\n`;

      const lastTwo = logs
  .filter(l => !l.isFromLive) // finalized logs only
  .slice(-2)
  .sort((a, b) => a.order - b.order); // ✅ ensure Attack 1, Attack 2 sequence
      if (lastTwo.length === 0) {
  msg += `Attack 1 → Not used\nAttack 2 → Not used\n`;
} else if (lastTwo.length === 1) {
  const atk1 = lastTwo[0];
  if (atk1.destructionPercentage === 0 && atk1.stars === 0) {
    msg += `Attack 1 → Not used\n`;
  } else {
    msg += `Attack 1 → vs ${atk1.oppName} → ${atk1.destructionPercentage}% (${atk1.stars}⭐)\n`;
  }
  msg += `Attack 2 → Not used\n`;
} else {
  lastTwo.forEach((atk, i) => {
    if (atk.destructionPercentage === 0 && atk.stars === 0) {
      msg += `Attack ${i + 1} → Not used\n`;
    } else {
      msg += `Attack ${i + 1} → vs ${atk.oppName} → ${atk.destructionPercentage}% (${atk.stars}⭐)\n`;
    }
  });
}
      msg += "\n";
    }
  } else {
    msg += `📜 *War History:*\nNo saved logs right now ❌\n`;
  }

  return await sock.sendMessage(jid, { text: msg });
}
  } catch (err) {
    console.error("cminfo error:", err);
    return await sock.sendMessage(jid, { text: "❌ Error fetching clan info." });
  }
};

// Helper to format war times
function formatWarTime(apiTime) {
  if (!apiTime) return "Unknown";
  const date = new Date(apiTime);
  if (isNaN(date.getTime())) return "Unknown";
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

// ------------------------- 📌 Attendance Command -------------------------
HANDLERS.attendance = async ({ sock, jid, args, sender, isGroup }) => {
  try {
    const key = isGroup ? sender : jid; // group me per-user
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, { 
        text: `✅ Usage: ${CONFIG.COMMAND_PREFIX}attendance #CLANTAG or set default with ${CONFIG.COMMAND_PREFIX}setclan #CLANTAG`
      });
    }

    const logs = DB.attendanceLogs?.[clanTag];
    if (!logs) {
      return await sock.sendMessage(jid, { text: "📭 Attendance logs not ready yet. Please wait (auto-updates every 30 min)." });
    }

    let rep = `🧮 *Attendance Report (Last Month)*\n`;
    rep += `🏰 Clan: ${logs.clanName}\n`;
    rep += `⏳ Last Updated: ${moment(logs.lastUpdated).fromNow()}\n`;
    rep += `👥 Current Members: ${logs.total}\n`;
    rep += `✅ Present: ${logs.present} (${logs.percentPresent}%)\n`;
    rep += `❌ Absent: ${logs.absent} (${logs.percentAbsent}%)\n`;

    if (logs.leaved.length > 0) {
      rep += `\n📉 *Players who left clan in past days* (${logs.leaved.length}):\n`;
      for (const tag of logs.leaved) {
        rep += `- ${tag}\n`;
      }
    }

    await sock.sendMessage(jid, { text: rep });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error fetching attendance: ${e.message}` });
  }
};

// Helper: format minutes into H:M
function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

HANDLERS.whenwar = async ({ sock, jid, args, sender, isGroup }) => {
  try {
    // group me per-user ka setclan ka data le
    const key = isGroup ? sender : jid;
    const clanTag = args[0] || DB.userClans[key];

    if (!clanTag) {
      return await sock.sendMessage(jid, {
        text: `⏳ Usage: ${CONFIG.COMMAND_PREFIX}whenwar #CLANTAG or set default with ${CONFIG.COMMAND_PREFIX}setclan #CLANTAG`
      });
    }

    const war = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
    if (war.error) {
      return await sock.sendMessage(jid, { text: `❌ Error: ${war.message || "Unknown"}` });
    }

    let out = `⚔️ *War Status*\n🏰 Clan: ${war.clan?.name || "?"}\n⚔️ Opponent: ${war.opponent?.name || "?"}\n📌 State: ${war.state}`;

    if (war.state === "inWar" && war.endTime) {
      const end = moment(war.endTime);
      const diffMin = Math.max(0, Math.floor(moment(end).diff(moment(), "minutes")));
      out += `\n⏳ Ends in: ${formatMinutes(diffMin)}`;
    } else if (war.state === "preparation" && war.startTime) {
      const start = moment(war.startTime);
      const diffMin = Math.max(0, Math.floor(moment(start).diff(moment(), "minutes")));
      out += `\n⏳ Starts in: ${formatMinutes(diffMin)}`;
    } else if (war.state === "warEnded") {
      out += `\n🏁 War has ended. Please wait for preparation day.`;
    }

    await sock.sendMessage(jid, { text: out });

  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  }
};


// ------------------------- ⚡ startLiveWatcher (optional) -------------------------
async function startLiveWatcher(/* clanTag, sock */) {
  // If you want live polling per-attack, implement here.
  // We already have global ticker handleWarNotifications running.
}

// ------------------------- 🤖 Start Bot -------------------------
let globalSock = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    auth: state,
    printQRInTerminal: false, // deprecated, we print manually below
    getMessage: async key => ({ conversation: 'Bot' })
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // print QR
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR code above with your WhatsApp app.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startBot().catch(err => console.error('reconnect error:', err.message));
      } else {
        console.log('Logged out. Please rescan QR code to connect.');
      }
    } else if (connection === 'open') {
      console.log('Bot is connected! ✅');
      globalSock = sock;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ----------------- Message handler -----------------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg || !msg.message) return;

    const jid = msg.key.remoteJid;
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
    const text = msg.message?.extendedTextMessage?.text || msg.message?.conversation || '';

    // ✅ Group check
    const isGroupChat = isJidGroup(jid);

    // ✅ Multiple owner support
const OWNER_JIDS = (CONFIG.OWNER_JIDS || CONFIG.OWNER_JID || "")
    .split(",")
    .map(j => String(j).trim());

    // ✅ DM me first time welcome
    if (!isGroupChat) {
        if (!DB.welcomedUsers) DB.welcomedUsers = {};
        if (!DB.welcomedUsers[sender]) {
            DB.welcomedUsers[sender] = true;
            saveDB();
            await sock.sendMessage(jid, {
                text: `Hey there! I'm *${CONFIG.BOT_NAME}* 🤖\n\nType *help* to see what I can do!`
            });
        }
    }

// ✅ Group me pehli baar add hone par welcome
const isGroup = jid.endsWith("@g.us");   // 👈 define isGroup here

if (isGroup) {   // 👈 now this check will work correctly
    if (!DB.welcomedGroups) DB.welcomedGroups = {};
    if (!DB.welcomedGroups[jid]) {
        DB.welcomedGroups[jid] = true;
        saveDB();
        await sock.sendMessage(jid, {
            text: `Hey everyone! I'm *${CONFIG.BOT_NAME}* 🤖\n\nType *help* to see what I can do!`
        });
    }
}


const isOwner = OWNER_JIDS.includes(sender);
    const isAuthorizedForGroup = !!DB.authorisedGroups[jid];
    const isAuthorizedForDM = !!DB.authorisedUsers[sender];
    const isAuthorized = isOwner || isAuthorizedForGroup || isAuthorizedForDM;

    // Self-message fix: allow owner, block spam loops
if (msg.key.fromMe) {
    // Sirf owner ka self message allow karo
    if (sender !== CONFIG.OWNER_JID) return;

    // Agar pichla message same hai to ignore (loop prevent)
    if (DB.lastMessages[sender] && DB.lastMessages[sender] === text) return;

    // Store last message
    DB.lastMessages[sender] = text;
}

    // -------- Instagram download (no prefix required) --------
    if (text.includes('instagram.com/')) {
      try {
        await sock.sendMessage(jid, { text: '📥 Downloading your media, please wait...' });

        const outputDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

        const filePrefix = path.join(outputDir, `${msg.key.id}`);
        const ytDlpCommand = process.platform === 'win32' ? path.join(__dirname, 'yt-dlp.exe') : path.join(__dirname, 'yt-dlp');

        // if file already exists
        const existing = fs.readdirSync(outputDir).filter(f => f.startsWith(msg.key.id));
        if (existing.length > 0) {
          const p = path.join(outputDir, existing[0]);
          await sock.sendMessage(jid, { video: { url: p }, caption: `✅ Already downloaded:\n${text}` });
          return;
        }

        const cmd = `"${ytDlpCommand}" --cookies cookies.txt -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --output "${filePrefix}.%(ext)s" --no-playlist "${text}"`;

        exec(cmd, { cwd: __dirname, timeout: 180000 }, async (error) => {
          if (error) {
            await sock.sendMessage(jid, { text: `❌ Failed to download: ${error.message}` });
            return;
          }
          const files = fs.readdirSync(outputDir).filter(f => f.startsWith(msg.key.id));
          if (files.length > 0) {
            const fp = path.join(outputDir, files[0]);
            await sock.sendMessage(jid, { video: { url: fp }, caption: `✅ Downloaded:\n${text}` });
            try { fs.unlinkSync(fp); } catch {}
          } else {
            await sock.sendMessage(jid, { text: '❌ Downloaded but file not found.' });
          }
        });
      } catch (e) {
        await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
      }
      return;
    }

    // -------- Commands with or without prefix --------
    const cleanedText = text.trim();
    if (!cleanedText) return;

    const eatPrefix = (str) => {
      const p = CONFIG.COMMAND_PREFIX;
      return str.startsWith(p) ? str.slice(p.length) : str;
    };

    const lowered = cleanedText.toLowerCase();
    const parts = eatPrefix(lowered).split(/\s+/);
    const command = parts[0] || '';
    const args = parts.slice(1);

    // if not a known command but AI mode enabled, route to AI
    const isKnown = Object.prototype.hasOwnProperty.call(HANDLERS, command);

    if (isKnown) {
      // permissions
      const cocCommands = [
  'claninfo', 'player', 'playerstats', 'warinfo', 'liveattack', 'clanmembers',
  'warlog', 'warlogs', 'attendance', 'capitalraids', 'clancapital', 'donations',
  'goldpass', 'locations', 'checkmembers', 'leagues', 'warleagues', 'topclans',
  'topplayers', 'clanrankings', 'playerrankings', 'setclan', 'removeclan', 'whenwar',
  'cm', 'cminfo', 'warnotify'
];

      const adminCommands = ['add', 'remove', 'addgroup', 'removegroup'];

      if (cocCommands.includes(command)) {
  if (isGroupChat && !isAuthorizedForGroup) {
    return await sock.sendMessage(jid, {
      text: '❌ This group is not authorized to use this command.'
    });
  }
  if (!isGroupChat && !isAuthorizedForDM) {
    return await sock.sendMessage(jid, {
      text: '❌ You are not authorized to use this command in DM.'
    });
  }
}
      if (adminCommands.includes(command) && !isOwner) {
        return await sock.sendMessage(jid, { text: '❌ You are not an admin.' });
      }

      if (!isOwner && isOnCooldown(sender)) {
        return await sock.sendMessage(jid, { text: '⏳ Cooldown! Please wait before sending another command.' });
      }
      setCooldown(sender);

      try {
        await HANDLERS[command]({
          sock, jid, sender, args,
          isGroup: isGroupChat,
          isOwner,
          isAuthorized, isAuthorizedForGroup, isAuthorizedForDM,
          msg
        });
      } catch (e) {
        console.error('Command error:', command, e);
        await sock.sendMessage(jid, { text: `❌ Error running command: ${e.message}` });
      }
    } else if (DB.aiModeUsers[sender]) {
  // AI mode
  if (!isOwner && isOnCooldown(sender, CONFIG.AI_COOLDOWN_SEC)) {
    return await sock.sendMessage(jid, { 
      text: `⏳ Thoda intezaar karein. (AI cooldown: ${CONFIG.AI_COOLDOWN_SEC}s)` 
    });
  }
  setCooldown(sender, CONFIG.AI_COOLDOWN_SEC);

  // Initialize AI chat history if not exists
  DB.aiChatHistory[sender] = DB.aiChatHistory[sender] || [
    { role: 'system', content: `You are Saad's helpful bot named ${CONFIG.BOT_NAME}. 
      Respond helpfully and conversationally in Hinglish where possible.` }
  ];
  
  // Save user message
DB.aiChatHistory[sender].push({ role: 'user', content: text });

await sock.sendMessage(jid, { text: '🤖 Generating a response... ⏳' });

// Get AI reply
let aiResponse;
try {
    aiResponse = await groqChat(DB.aiChatHistory[sender]);
} catch (err) {
    console.error("AI Error:", err);
    return await sock.sendMessage(jid, { 
        text: "❌ AI se reply lene me problem aayi. API key sahi hai ya nahi check karo." 
    });
}

// Only send AI response now
if (!aiResponse || aiResponse.trim() === "") {
    return await sock.sendMessage(jid, { text: "❌ AI ka reply blank aaya." });
}

DB.aiChatHistory[sender].push({ role: 'assistant', content: aiResponse });
saveDB();
await sock.sendMessage(jid, { text: aiResponse });
} // AI mode block ka close
}); // event listener ka close

return sock;
}

// ------------------------- 🚀 Launch -------------------------
let sock = null;

async function main() {
  sock = await startBot();

  const fs = require("fs");

// ------------------------- DB Helpers -------------------------
function loadDB() {
  try {
    const data = JSON.parse(fs.readFileSync("db.json", "utf8"));
    return { ...DEFAULT_DB, ...data }; // ensure all keys present
  } catch (e) {
    console.error("⚠️ Could not load db.json, starting fresh.");
    return { ...DEFAULT_DB };
  }
}

function saveDB() {
  try {
    fs.writeFileSync("db.json", JSON.stringify(DB, null, 2));
    console.log("💾 DB saved");
  } catch (err) {
    console.error("❌ Error saving DB:", err.message);
  }
}

// ------------------------- AUTO-SAVE CURRENT WAR ATTACKS -------------------------
setInterval(async () => {
  console.log("⏳ Auto warlog save check started...");
  try {
    for (const jid in DB.userClans) {
      const clanData = DB.userClans[jid];
      if (!clanData) continue;

      const clanTag = typeof clanData === "string" ? clanData : clanData.clanTag;
      if (!clanTag) continue;

      const warData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
      if (!warData || warData.state !== "inWar") {
        console.log(`⚠️ Skipped clan ${clanTag} (not in war)`);
        continue;
      }

      const warId = `${warData.clan.tag}_${warData.opponent.tag}_${warData.endTime}`;

      for (const m of warData.clan.members) {
        const playerTag = m.tag;
        if (!DB.playerWarLogs[playerTag]) DB.playerWarLogs[playerTag] = [];

        const attacks = m.attacks || [];
        const usedOrders = new Set(attacks.map(a => a.order));

        // Save actual attacks
        for (const atk of attacks) {
          const warKey = `${warId}_${playerTag}_${atk.order}`;
          if (DB.playerWarLogs[playerTag].some(l => l.warKey === warKey)) continue;

          const opponentMember = warData.opponent?.members?.find(o => o.tag === atk.defenderTag);
          const opponentName = opponentMember?.name || "Unknown";

          DB.playerWarLogs[playerTag].push({
            warKey,
            warId,
            clanTag: warData.clan.tag,
            oppClanTag: warData.opponent.tag,
            myClan: warData.clan.name,
            oppClan: warData.opponent.name,
            myName: m.name,
            oppName: opponentName,
            stars: atk.stars,
            destructionPercentage: atk.destructionPercentage,
            order: atk.order,
            defenderTag: atk.defenderTag,
            isFromLive: true,
            unused: false,
            time: new Date().toISOString()
          });

          console.log(`✅ Saved LIVE warlog for ${m.name}: ${atk.stars}⭐ vs ${opponentName}`);
        }

        // Save unused slots
        for (let order = 1; order <= 2; order++) {
          if (!usedOrders.has(order)) {
            const warKey = `${warId}_${playerTag}_${order}`;
            if (DB.playerWarLogs[playerTag].some(l => l.warKey === warKey)) continue;

            DB.playerWarLogs[playerTag].push({
              warKey,
              warId,
              clanTag: warData.clan.tag,
              oppClanTag: warData.opponent.tag,
              myClan: warData.clan.name,
              oppClan: warData.opponent.name,
              myName: m.name,
              oppName: "Unused",
              stars: 0,
              destructionPercentage: 0,
              order,
              defenderTag: null,
              unused: true,
              isFromLive: true,
              time: new Date().toISOString()
            });

            console.log(`⚪ Saved UNUSED slot for ${m.name} (Attack ${order})`);
          }
        }

        // Keep last 10 logs
        if (DB.playerWarLogs[playerTag].length > 10) {
          DB.playerWarLogs[playerTag] = DB.playerWarLogs[playerTag].slice(-10);
        }
      }
    }

    saveDB();
  } catch (e) {
    console.error("Auto warlog save error:", e.message);
  }
}, 5 * 60 * 1000);

// ------------------------- REMOVE CLAN -------------------------
async function removeClan(jid) {
  DB.userClans = DB.userClans || {};
  DB.playerWarLogs = DB.playerWarLogs || {};
  DB.removedClanLogs = DB.removedClanLogs || {};
  DB.pendingFinalization = DB.pendingFinalization || {};

  if (!DB.userClans[jid]) return "❌ No clan set currently.";

  const clanTag = typeof DB.userClans[jid] === "string" ? DB.userClans[jid] : DB.userClans[jid].clanTag;

  const backup = {};
  for (const [playerTag, logs] of Object.entries(DB.playerWarLogs || {})) {
    backup[playerTag] = logs.filter(l => l.clanTag === clanTag);
  }
  DB.removedClanLogs[clanTag] = backup;
  console.log(`📦 Backed up ${clanTag} logs before removing.`);

  DB.pendingFinalization[clanTag] = true;
  delete DB.userClans[jid];
  saveDB();
  return `⚠️ Clan ${clanTag} removed.`;
}
globalThis.removeClan = removeClan;

// ------------------------- SET CLAN -------------------------
async function setClan(jid, clanTag) {
  DB.userClans = DB.userClans || {};
  DB.playerWarLogs = DB.playerWarLogs || {};
  DB.removedClanLogs = DB.removedClanLogs || {};
  DB.pendingFinalization = DB.pendingFinalization || {};

  if (!clanTag) return "❌ Please provide a clan tag eg: setclan #CLANTAG.";
  let tag = String(clanTag).trim().toUpperCase();
  if (!tag.startsWith("#")) tag = `#${tag}`;

  const oldClan = DB.userClans[jid];
  if (oldClan) {
    const oldTag = typeof oldClan === "string" ? oldClan : oldClan.clanTag;
    if (!DB.removedClanLogs[oldTag]) {
      const backup = {};
      for (const [playerTag, logs] of Object.entries(DB.playerWarLogs || {})) {
        backup[playerTag] = logs.filter(l => l.clanTag === oldTag);
      }
      DB.removedClanLogs[oldTag] = backup;
      console.log(`📦 Backed up ${oldTag} logs before switching clan.`);
    }
    DB.pendingFinalization[oldTag] = true;
  }

  DB.userClans[jid] = tag;

  if (DB.removedClanLogs[tag]) {
    for (const [playerTag, logs] of Object.entries(DB.removedClanLogs[tag])) {
      if (!DB.playerWarLogs[playerTag]) DB.playerWarLogs[playerTag] = [];
      for (const log of logs) {
        if (!DB.playerWarLogs[playerTag].some(l => l.warKey === log.warKey)) {
          DB.playerWarLogs[playerTag].push(log);
        }
      }
    }
    console.log(`♻️ Restored old logs for clan ${tag}.`);
    delete DB.removedClanLogs[tag];
  }

  saveDB();
  return `✅ Clan ${tag} set successfully.`;
}
globalThis.setClan = setClan;

const { spawn } = require("child_process");

function runGetWarLogs() {
  DB = loadDB();

  const clans = new Set(Object.values(DB.userClans).map(c => (typeof c === "string" ? c : c.clanTag)).filter(Boolean));
  for (const clanTag of clans) {
    cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`).then(warData => {
      if (!warData) return;
      if (warData.state === "inWar") return; // skip live wars

      // Run like terminal
      spawn("node", ["getlogwar.js"], { stdio: "inherit" });
    });
  }
}

// run immediately
runGetWarLogs();

// run every 3 minutes
setInterval(runGetWarLogs, 3 * 60 * 1000);

// every minute: war notifications
  setInterval(async () => {
    try {
      if (globalSock) await handleWarNotifications(globalSock);
    } catch (e) {
      console.error('Notify ticker error:', e.message);
    }
  }, 60 * 1000);
} // ✅ closes async function main()

main().catch(err => console.error('Main error:', err.message));

// =============================================================================
// END
// =============================================================================