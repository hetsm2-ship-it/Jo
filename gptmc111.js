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
const fs = require("fs");
const { Client } = require("ssh2");
const fsp = require("fs").promises;
const pino = require("pino"); //unctions ke liye
const path = require('path');
const moment = require('moment');
const fetch = require('node-fetch'); // v2
const qrcode = require('qrcode-terminal');
const { exec, execFile } = require('child_process');

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
  OWNER_JIDS: (process.env.OWNER_JIDS || '').trim(), // e.g., 91XXXXXXXXXX@s.whatsapp.net
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

// Yeh line hatao:
// if (!fs.existsSync(CONFIG.STATE_DIR)) fs.mkdirSync(CONFIG.STATE_DIR, { recursive: true });

// Replace with this:
if (!fs.existsSync(CONFIG.STATE_DIR)) {
  fs.mkdirSync(CONFIG.STATE_DIR, { recursive: true });
}



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
  admins: {},          // Admins ke liye naya object
  offGroupCmds: {},    // Groups me commands off karne ke liye flag
  offDmCmds: {},       // DM me commands off karne ke liye flag
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
const SSH_CONFIG = {
  host: "172.233.174.221",
  port: 22,
  username: "master_evjtpazsnr",
  password: "Spyther@786"
};

// Active sessions
const activeTerminals = {}; // { userJid: { conn, cwd } }
const logger = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
  warn: (...a) => console.warn("[WARN]", ...a)
};

/**
 * Ensure DB has required buckets after loading/merging.
 */
function ensureDBDefaults() {
  for (const [k, v] of Object.entries(DEFAULT_DB)) {
    if (DB[k] === undefined || DB[k] === null) {
      DB[k] = Array.isArray(v) ? [] : (typeof v === 'object' ? { ...v } : v);
    }
  }
  
  // Additional keys for admin and command toggles
  if (DB.admins === undefined || DB.admins === null) DB.admins = {};
  if (DB.offGroupCmds === undefined || DB.offGroupCmds === null) DB.offGroupCmds = {};
  if (DB.offDmCmds === undefined || DB.offDmCmds === null) DB.offDmCmds = {};
}

function isBlockedCommand(cmd) {
  const blocked = ["nano", "vim", "vi", "less", "top", "htop"];
  return blocked.some(b => cmd.startsWith(b));
}
  

/**
 * Atomic save: write to tmp file then rename. Handles errors gracefully.
 */
const saveDB = async (context = 'unknown') => {
  try {
    const tmpFile = CONFIG.DB_FILE + '.tmp';  // ✅ DB_FILE use kar
    const data = JSON.stringify(DB, null, 2);

    // write temp file
    await fsp.writeFile(tmpFile, data, "utf8");

    // rename temp file -> main db.json
    await fsp.rename(tmpFile, CONFIG.DB_FILE);

  } catch (e) {
    try {
      const tmpFile = CONFIG.DB_FILE + '.tmp';
      await fsp.access(tmpFile);   // check if tmp file exists
      await fsp.unlink(tmpFile);   // cleanup
    } catch (_) {}
    console.error(`Failed to save DB for ${context}:`, e && e.message ? e.message : e);
  }
};

/**
 * Load DB from disk; on JSON parse error, back up corrupt file and start fresh.
 * Merge only object keys from saved file into in-memory DEFAULTS to avoid unexpected shape changes.
 */
const loadDB = async () => {
  try {
    try {
      await fsp.access(CONFIG.DB_PATH); // check file exists
    } catch {
      ensureDBDefaults();
      return;
    }

    const raw = await fsp.readFile(CONFIG.DB_PATH, "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (jsonErr) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const corruptBak = `${CONFIG.DB_PATH}.corrupt.${ts}.bak`;
      await fsp.rename(CONFIG.DB_PATH, corruptBak);
      console.error(`DB file was corrupt; moved to ${corruptBak}. Starting with fresh DB.`);
      parsed = {};
    }

    // merge defaults
    for (const [key, defVal] of Object.entries(DEFAULT_DB)) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        const parsedVal = parsed[key];
        if (isPlainObject(defVal) && isPlainObject(parsedVal)) {
          DB[key] = { ...defVal, ...parsedVal };
        } else if (Array.isArray(defVal) && Array.isArray(parsedVal)) {
          DB[key] = parsedVal.slice();
        } else if (typeof defVal === typeof parsedVal) {
          DB[key] = parsedVal;
        } else {
          DB[key] = Array.isArray(defVal) ? [] : (isPlainObject(defVal) ? { ...defVal } : defVal);
        }
      } else {
        DB[key] = Array.isArray(defVal) ? [] : (isPlainObject(defVal) ? { ...defVal } : defVal);
      }
    }

    for (const k of Object.keys(parsed || {})) {
      if (!Object.prototype.hasOwnProperty.call(DB, k)) {
        DB[k] = parsed[k];
      }
    }
  } catch (e) {
    console.error("Failed to load DB, starting fresh:", e && e.message ? e.message : e);
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
const safeSaveAndExit = async (code = 0) => {
  await saveDB('exit');
  process.exit(code);
};
process.on('SIGINT', () => safeSaveAndExit(0));
process.on('SIGTERM', () => safeSaveAndExit(0));
process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  await safeSaveAndExit(1);
});
process.on('beforeExit', async () => {
  await saveDB('beforeExit');
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

// --- Top level, file ke start ya imports ke baad ---

// Free commands: Accessible to all users, even in groups/DMs where commands are toggled off (unless explicitly blocked).
const freeCommands = Object.freeze([
  'start',        // Initiates bot interaction or shows welcome message
  'help',         // Displays available commands or help information
  'botinfo',      // Shows bot version, status, or general info
  'authstatus',   // Checks authorization status of user or group
  'info',         // General information (possibly redundant with botinfo)
  'qr',           // Generates or handles QR code-related functionality
  'enteraimode',  // Enables AI mode for conversational responses
  'exitaimode',   // Disables AI mode
  'instagram'     // Triggers Instagram media download (if prefix-based)
]);

// CoC commands: Clash of Clans-related commands, require group/user authorization via DB.authorisedGroups or DB.authorisedUsers.
const cocCommands = Object.freeze([
  'claninfo',      // Fetches clan information
  'player',        // Retrieves player details
  'playerstats',   // Shows detailed player statistics
  'warinfo',       // Provides current war information
  'liveattack',    // Monitors live attacks (if supported)
  'clanmembers',   // Lists clan members
  'warlog',        // Shows war log for the clan
  'warlogs',       // Alias or extended war log command
  'attendance',    // Tracks member participation
  'capitalraids',  // Fetches Clan Capital raid details
  'clancapital',   // Shows Clan Capital status
  'donations',     // Tracks donation statistics
  'goldpass',      // Provides Gold Pass-related info
  'locations',     // Lists CoC locations or region data
  'checkmembers',  // Checks member activity or status
  'leagues',       // Shows league information
  'warleagues',    // Fetches Clan War League details
  'topclans',      // Lists top clans by ranking
  'topplayers',    // Lists top players by ranking
  'clanrankings',  // Shows clan rankings
  'playerrankings',// Shows player rankings
  'setclan',       // Sets or updates clan tag for the bot
  'removeclan',    // Removes clan association
  'whenwar',       // Shows time until next war
  'cm',            // Alias for clan management or member check
  'cminfo',        // Clan management information
  'warnotify'      // Sets up war notifications
]);

// Admin commands: Restricted to owners and admins, used for bot control and authorization management.
const adminCommands = Object.freeze([
  'offgc',        // Disables all commands in a group
  'ongc',         // Enables all commands in a group
  'offdm',        // Disables all commands in a DM
  'ondm',         // Enables all commands in a DM
  'addadmin',
  'removeadmin',
  'slist',
   'enterterminal',
    'exitterminal',
     'terminalInput',
  'add',          // Adds a user to authorized users or admins
  'remove',       // Removes a user from authorized users or admins
  'addgroup',     // Authorizes a group for CoC commands
  'removegroup'   // Removes group authorization
]);
// Owner JIDs array, from config ENV variables (supports multiple owners comma separated)
const OWNER_JIDS = (CONFIG.OWNER_JIDS || "").split(",").map(j => j.trim()).filter(Boolean);

// Check if given jid is owner
function isOwner(jid) {
  return OWNER_JIDS.includes(jid);
}

// Check if given jid is admin in DB
function isAdmin(jid) {
  return !!(DB.admins && DB.admins[jid] === true);
}

// Check if jid is either owner or admin
function isOwnerOrAdmin(jid) {
  return isOwner(jid) || isAdmin(jid);
}

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

// Auto-update every 15 mins (ONLY if inWar)
setInterval(async () => {
  try {
    for (const [key, clanTag] of Object.entries(DB.userClans || {})) {
      if (!clanTag) continue;
      await updateAttendanceLogs(clanTag);
    }
  } catch (e) {
    console.error("Attendance auto-save error:", e.message);
  }
}, 15 * 60 * 1000); // 15 mins

async function updateAttendanceLogs(clanTag) {
  try {
    const liveWar = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
    if (!liveWar || liveWar.error || !liveWar.state) return;

    // ✅ Update only if inWar
    if (liveWar.state !== "inWar") {
      return;
    }

    const clanInfo = await cocFetch(`/clans/${encodeURIComponent(clanTag)}`);
    const clanMembers = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/members`);
    if (!clanMembers?.items) return;

    const presentPlayers = new Set();

    // InWar se present nikal lo
    if (liveWar.clan?.members) {
      for (const m of liveWar.clan.members) {
        if (m.attacks && m.attacks.length > 0) {
          presentPlayers.add(m.tag);
        }
      }
    }

    // Members ka join/leave compare
    const currentTags = clanMembers.items.map(m => m.tag);
    const oldRecord = DB.attendanceLogs?.[clanTag]?.lastSnapshot?.lastMembers || [];

    const leaved = oldRecord.filter(t => !currentTags.includes(t));
    const joined = currentTags.filter(t => !oldRecord.includes(t));

    const total = clanMembers.items.length;
    const presentCount = currentTags.filter(tag => presentPlayers.has(tag)).length;
    const absentCount = total - presentCount;

    // ✅ Initialize DB structure
    DB.attendanceLogs = DB.attendanceLogs || {};
    DB.attendanceLogs[clanTag] = DB.attendanceLogs[clanTag] || { records: [] };

    // ✅ Clean old records (>30 days)
    const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    DB.attendanceLogs[clanTag].records = DB.attendanceLogs[clanTag].records.filter(
      r => r.timestamp >= oneMonthAgo
    );

    // ✅ Create new snapshot
    const snapshot = {
      timestamp: Date.now(),
      clanName: clanInfo?.name || liveWar.clan?.name || "Unknown Clan",
      total,
      present: presentCount,
      absent: absentCount,
      percentPresent: ((presentCount / total) * 100).toFixed(1),
      percentAbsent: ((absentCount / total) * 100).toFixed(1),
      joined,
      leaved,
      lastMembers: currentTags
    };

    // ✅ Save lastSnapshot + history
    DB.attendanceLogs[clanTag].lastSnapshot = snapshot;
    DB.attendanceLogs[clanTag].records.push(snapshot);

    saveDB("attendance");
    console.log(`✅ Attendance updated for ${clanTag} (${presentCount}/${total})`);
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
    if (!logs?.lastSnapshot) {
      return await sock.sendMessage(jid, {
        text: "📭 Attendance logs not ready yet. They update automatically every 15 min (only during wars)."
      });
    }

    const latest = logs.lastSnapshot;
    const lastUpdatedText = moment(latest.timestamp).fromNow();

    let rep = `🧮 *Attendance Report (Last 30 Days)*\n`;
    rep += `🏰 Clan: ${latest.clanName}\n`;
    rep += `📅 Records stored: ${logs.records.length}\n`;
    rep += `⏳ Last Updated: ${lastUpdatedText}\n`;
    rep += `👥 Current Members: ${latest.total}\n`;
    rep += `✅ Present: ${latest.present} (${latest.percentPresent}%)\n`;
    rep += `❌ Absent: ${latest.absent} (${latest.percentAbsent}%)\n`;

    if (latest.joined?.length) {
      rep += `\n🆕 Joined: ${latest.joined.join(", ")}`;
    }
    if (latest.leaved?.length) {
      rep += `\n👋 Left: ${latest.leaved.join(", ")}`;
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
  const h = Math.floor(ms / (1000 * 60 * 60));
  const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const s = Math.floor((ms % (1000 * 60)) / 1000);
  return `${h.toString().padStart(2, "0")}:${m
    .toString()
    .padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ------------------------- HELPERS -------------------------
function makeWarId(war) {
  return `${war.clan.tag}_${war.opponent?.tag || "unknown"}_${war.startTime ||
    war.preparationStartTime ||
    war.endTime ||
    Date.now()}`;
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
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
    const participants = (meta?.participants || []).map(
      (p) => p?.id || p?.jid || p
    );
    _groupParticipantsCache.set(groupJid, { ts: now, participants });
    return participants;
  } catch (e) {
    console.error("⚠️ groupMetadata failed:", groupJid, e.message);
    return [];
  }
}

// ------------------------- Milestone Helper -------------------------
function pickLatestOverdueMilestone(now, endTime, allMilestones, baseKey) {
  // Order: 15m, 1h, 3h, 6h, 12h
  const ordered = [
    ...allMilestones.filter((m) => m.m === 15),
    ...allMilestones.filter((m) => m.h === 1),
    ...allMilestones.filter((m) => m.h === 3),
    ...allMilestones.filter((m) => m.h === 6),
    ...allMilestones.filter((m) => m.h === 12),
  ];

  for (const m of ordered) {
    const notifyKey = `${baseKey}:${m.key}`;
    const triggerTime = endTime - (m.h ? m.h * 3600 * 1000 : m.m * 60 * 1000);
    if (now >= triggerTime && !DB.lastWarNotificationSent[notifyKey])
      return { m, notifyKey };
  }
  return null;
}

// ------------------------- Resolve targets for a clan -------------------------
async function resolveTargetsForClan(sock, clanTag) {
  const normalizedClanTag = clanTag.toUpperCase().trim();

  // 1️⃣ Direct DB.userClans mappings
  const explicitTargets = Object.entries(DB.userClans || {})
    .filter(([, data]) => {
      if (!data) return false;
      const tag = typeof data === "string" ? data : data?.clanTag;
      return tag?.toUpperCase().trim() === normalizedClanTag;
    })
    .map(([jid]) => jid);

  let groupTargets = uniq(explicitTargets.filter((t) => t.endsWith("@g.us")));
  let userTargets = uniq(explicitTargets.filter((t) => !t.endsWith("@g.us")));

  // 🔒 Remove unauthorized groups
  groupTargets = groupTargets.filter((g) => !!DB.authorisedGroups[g]);

  // 2️⃣ Groups with members having same clan (DB.groupMemberClans)
  for (const [gJid, membersMap] of Object.entries(DB.groupMemberClans || {})) {
    const hasClan = Object.values(membersMap || {}).some(
      (tag) => tag.toUpperCase().trim() === normalizedClanTag
    );
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
        if (tag && tag.toUpperCase().trim() === normalizedClanTag) {
          anyMemberHasClan = true;
          break;
        }
      }
    }
    if (anyMemberHasClan) groupTargets.push(gJid);
  }

  // 🔒 Remove unauthorized groups
  groupTargets = groupTargets.filter((g) => !!DB.authorisedGroups[g]);

  return { groupTargets: uniq(groupTargets), userTargets: uniq(userTargets) };
}

// ------------------------- Handle War Notifications -------------------------
async function handleWarNotifications(sock) {
  try {
    ensureNotifyStore();

    // Get unique normalized clan tags from DB.userClans
    const normalizedClanTags = Array.from(new Set(Object.values(DB.userClans)
      .map(d => {
        const tag = typeof d === 'string' ? d : d?.clanTag;
        if (!tag) return null;
        let cleanTag = tag.toUpperCase().trim();
        cleanTag = cleanTag.replace(/O/g, '0');
        if (!cleanTag.startsWith('#')) cleanTag = '#' + cleanTag;
        return cleanTag;
      }).filter(Boolean)));

    if (normalizedClanTags.length === 0) {
      console.log("⏩ No clans in DB.userClans");
      return;
    }

    for (const clanTag of normalizedClanTags) {
      try {
        console.log("\n===============================");
        console.log("🔎 Checking clan:", clanTag);

        const war = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
        if (!war || war.error || !war.state) {
          console.log("⚠️ No valid war for", clanTag, war?.message || "");
          continue;
        }

        console.log("📡 War state:", war.state);

        // Resolve targets with exact normalized clanTag match
        const { groupTargets, userTargets } = await resolveTargetsForClan(sock, clanTag);

        if (!groupTargets.length && !userTargets.length) {
          console.log("⏩ No targets found for", clanTag);
          continue;
        }

        const baseKey = `${clanTag}:${war.preparationStartTime || war.startTime || "unknown"}`;

        if (war.state === "preparation") {
          console.log("⏩ Skipping preparation for", clanTag);
          continue;
        }

        const now = Date.now();

        if (war.state === "inWar") {
          const endTime = parseCoCTime(war.endTime)?.getTime();
          if (!endTime) {
            console.error("❌ Invalid war.endTime for", clanTag);
            continue;
          }
          const diffMs = endTime - now;
          if (diffMs <= 0) {
            console.log("⏩ War already ended");
            continue;
          }

          const allMilestones = [
            { h: 12, key: "inwar12h" },
            { h: 6, key: "inwar6h" },
            { h: 3, key: "inwar3h" },
            { h: 1, key: "inwar1h" },
            { m: 15, key: "inwar15m" },
          ];

          const pick = pickLatestOverdueMilestone(now, endTime, allMilestones, baseKey);

          if (pick) {
            console.log(`🚀 Sending ${pick.m.key} notification for ${clanTag}`);
            await sendWarNotificationToTargets(sock, war, userTargets, groupTargets, diffMs);
            DB.lastWarNotificationSent[pick.notifyKey] = now;
            saveDB();
          } else {
            console.log("⏩ No pending milestones for", clanTag);
          }
        }

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
            DB.lastWarNotificationSent[endedKey] = now;
            saveDB();
          } else {
            console.log("⏩ War ended notification already sent for", clanTag);
          }
        }
      } catch (err) {
        console.error("❌ notify error for", clanTag, err.message || err);
      }
    }
  } catch (err) {
    console.error("❌ handleWarNotifications failed:", err.message || err);
  }
}


// ------------------------- ⚔️ Send War Notification -------------------------
async function sendWarNotificationToTargets(
  sock,
  war,
  userTargets = [],
  groupTargets = [],
  timeLeft = null,
  overrideMsg = null
) {
  // 17 seconds extra buffer add kar diya
  const extraMs = 17 * 1000;
  if (timeLeft !== null) timeLeft += extraMs;

  const defaultMsg =
    timeLeft !== null
      ? `⚔️ *War Live Update*\n` +
        `War ends in: ${formatTimeLeft(timeLeft)}\n` +
        `⚠️ Do your attacks!\n` +
        `Clan: ${war.clan?.name}\n` +
        `Vs: ${war.opponent?.name}\n` +
        `Attacks: ${war.clan?.attacks || 0}\n` +
        `Stars: ${war.clan?.stars || 0} - ${war.opponent?.stars || 0}\n` +
        `Destruction: ${(war.clan?.destructionPercentage ?? 0).toFixed(2)}% - ${(war.opponent?.destructionPercentage ??
          0).toFixed(2)}%`
      : overrideMsg || "⚔️ War Update";

  const msgToSend = overrideMsg || defaultMsg;

  console.log("📤 Sending notification:\n", msgToSend);

  // --- Groups ---
  const sentGroups = new Set();
  for (const g of uniq(groupTargets)) {
  if (DB.offGroupCmds?.[g]) {
    console.log("⏩ Skipping disabled group:", g);
    continue;
  }
     if (sentGroups.has(g)) continue;
    try {
      console.log("➡️ Sending to group:", g);
      await sock.sendMessage(g, { text: msgToSend }).catch(() => {});
      sentGroups.add(g);
    } catch (e) {
      console.error("⚠️ Group send error:", g, e.message);
    }
  }

  // --- Users (owner + authorised) ---
  const ownerJid = CONFIG.OWNER_JID?.trim();
  for (const u of uniq(userTargets)) {
     if (DB.offDmCmds?.[u]) {
  console.log("⏩ Skipping disabled user:", u);
  continue;
}
     try {
      const userIsOwner = ownerJid && u === ownerJid;
      const isUserAuth = !!DB.authorisedUsers?.[u];
      if (userIsOwner || isUserAuth) {
        console.log("➡️ Sending to user:", u);
        await sock.sendMessage(u, { text: msgToSend }).catch(() => {});
      } else {
        console.log("❌ Skipping DM for", u, "(not authorised)");
      }
    } catch (e) {
      console.error("⚠️ User send error:", u, e.message);
    }
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
        model: "meta-llama/llama-4-scout-17b-16e-instruct", // Tum model change kar sakte ho
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
claninfo - [optional #CLANTAG] 🏰
player - #PLAYERTAG 👤
playerstats - #PLAYERTAG 📊
liveattack - [track your clan war stats] ⚡️
warlog - [get your 10 last clan war details] 📜
cminfo or cminfo <member-number> - [see clan members, details and war history] 🪖
attendance - [get your clan attendance details] ✅
capitalraids - [get your clan capitalraids deatils] 🏦
clancapital - [get your clan clancapital details] 🏛️
donations - [get your clan donations details] 🎁
goldpass - [see goldpass]🏆
locations - [view locations] 🗺️
leagues - [view leagues]🏅
warleagues - [view warleagues]🛡️
topclans [optional location ID] 🥇
topplayers [optional location ID] 👑
clanrankings [optional location ID] 📈
playerrankings [optional location ID] 📊
setclan : #CLANTAG [set your current clan] 🏠
removeclan : [remove your current setclan] ❌
whenwar : [check war status for your clan] ⏳

*Owner + Admins:*
add - [user_jid] ➕
remove - [user_jid] ➖
addgroup - ➕
removegroup - ➖
enterterminal - [enters in terminal mode] 💻 
exitterminal - [exit terminal mode] 💻 
offgc - [turn off all commands+notification for everyone in group] 📴
ongc - [turn on all commands+notification for everyone in gc] 🔛
offdm / offdm [jid] - [off commands+notification in dms] 📴
ondm / ondm [jid] - [on commands+notification in dms] 🔛
addadmin - [owner can add admins] 👥
removeadmin - [owner can remove admins]
slist - [owner can views totals list of users]
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

  authstatus: async ({ sock, jid, sender, isGroup }) => {
  const normalizedJid = jidNormalizedUser(jid);
  const normalizedSender = jidNormalizedUser(sender);

  // Debug logs
  console.log('[DEBUG] Authorized Groups:', DB.authorisedGroups);
  console.log('[DEBUG] Authorized Users:', DB.authorisedUsers);
  console.log('[DEBUG] Checking for JID:', normalizedJid, 'Sender:', normalizedSender);

  const isOwnerFlag = isOwner(normalizedSender);
  const isAdminFlag = isAdmin(normalizedSender);
  const isAuthorizedForGroup = !!DB.authorisedGroups?.[normalizedJid];
  const isAuthorizedForDM = !!DB.authorisedUsers?.[normalizedSender];

  const statusIcon = (status) => (status ? "✅" : "❌");

  // Group row sirf tab dikhayenge jab isGroup true hai
  const groupRow = isGroup 
    ? `│ 👥 *Group Access* : ${statusIcon(isAuthorizedForGroup)}\n`
    : '';

  const msg =
    `╭────────────────────────────╮\n` +
    `│ 🔐 *AUTHORIZATION STATUS* │\n` +
    `├────────────────────────────┤\n` +
    `│ 👑 *Owner*        : ${statusIcon(isOwnerFlag)}\n` +
    `│ 🛡️ *Admin*        : ${statusIcon(isAdminFlag)}\n` +
    groupRow +
    `│ 💬 *Direct Access*: ${statusIcon(isAuthorizedForDM)}\n` +
    `╰────────────────────────────╯`;

  await sock.sendMessage(jid, { text: msg });
}
};

  HANDLERS.info = async ({ sock, jid, sender, msg }) => {
  try {
    // ✅ Name with proper fallback
    let name = msg?.pushName?.trim();
    if (!name) {
      try {
        name = await sock.getName(sender);
      } catch {
        name = null;
      }
    }
    if (!name) {
      name = "Unavailable"; // final fallback
    }

    const number = sender?.split("@")[0] || "Unknown";

    // ✅ Profile picture
    let profilePic = null;
    try {
      profilePic = await sock.profilePictureUrl(sender, "image");
    } catch {
      profilePic = null;
    }

    // ✅ Battery info
    let batteryInfo = "Not Available";
    if (sock?.ws?.battery !== undefined) {
      batteryInfo = `${sock.ws.battery}% ${sock.ws.plugged ? "(Charging)" : ""}`;
    }

    // ✅ Message text
    let infoText = `📋 *Your Info:*\n`;
    infoText += `👤 Name: ${name}\n`;
    infoText += `📞 Number: ${number}\n`;
    infoText += `🆔 JID: ${sender}\n`;
    infoText += `🔋 Battery: ${batteryInfo}`;

    if (profilePic) {
      await sock.sendMessage(jid, {
        image: { url: profilePic },
        caption: infoText,
      });
    } else {
      await sock.sendMessage(jid, { text: infoText });
    }
  } catch (err) {
    console.error("Info command error:", err);
    await sock.sendMessage(jid, { text: "❌ There's problem in fetching." });
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

// ------------------------- 👑 Add / Remove Admins -------------------------

HANDLERS.addadmin = async ({ sock, jid, args, sender }) => {
  if (sender !== CONFIG.OWNER_JID) {
    return sock.sendMessage(jid, { text: "❌ Sirf *owner* hi `addadmin` chala sakta hai." });
  }

  const adminJid = args[0];
  if (!adminJid) {
    return sock.sendMessage(jid, { text: `Usage: ${CONFIG.COMMAND_PREFIX}addadmin 91XXXXXXXXXX@s.whatsapp.net` });
  }

  DB.admins = DB.admins || {};
  DB.admins[adminJid] = true;
  saveDB();

  return sock.sendMessage(jid, { text: `✅ ${adminJid} ko admin bana diya gaya hai.` });
};

HANDLERS.removeadmin = async ({ sock, jid, args, sender }) => {
  if (sender !== CONFIG.OWNER_JID) {
    return sock.sendMessage(jid, { text: "❌ Sirf *owner* hi `removeadmin` chala sakta hai." });
  }

  const adminJid = args[0];
  if (!adminJid) {
    return sock.sendMessage(jid, { text: `Usage: ${CONFIG.COMMAND_PREFIX}removeadmin 91XXXXXXXXXX@s.whatsapp.net` });
  }

  DB.admins = DB.admins || {};
  if (DB.admins[adminJid]) {
    delete DB.admins[adminJid];
    saveDB();
    return sock.sendMessage(jid, { text: `✅ ${adminJid} ko admin list se hata diya gaya hai.` });
  } else {
    return sock.sendMessage(jid, { text: `❌ ${adminJid} admin list me nahi hai.` });
  }
};

// ✅ Enter Terminal Mode
HANDLERS.enterterminal = async ({ sock, jid, sender }) => {
  if (!isOwnerOrAdmin(sender)) {
    return sock.sendMessage(jid, {
      text: "❌ Sirf owner aur admins hi terminal mode use kar sakte hain."
    });
  }

  // Agar pehle se active hai toh warn karo
  if (activeTerminals[sender]) {
    return sock.sendMessage(jid, {
      text: "⚠️ Aap already terminal mode me ho. Exit karne ke liye `exitterminal` likho."
    });
  }

  // Naya SSH client banate hain
  const conn = new Client();

  conn.on("ready", async () => {
    // ✅ Default directory set
    activeTerminals[sender] = {
      conn,
      cwd: "/home/master" 
    };

    await sock.sendMessage(jid, {
      text: "💻 *SSH Terminal mode ON*\nAb aap commands bhej sakte ho.\nType `exitterminal` to exit."
    });
  });

  conn.on("error", async (err) => {
    await sock.sendMessage(jid, {
      text: `❌ SSH connection error: ${err.message}`
    });
  });

  // Connect to VPS
  conn.connect(SSH_CONFIG);
};

// ✅ Exit Terminal Mode
HANDLERS.exitterminal = async ({ sock, jid, sender }) => {
  if (!isOwnerOrAdmin(sender)) {
    return sock.sendMessage(jid, { text: "❌ Sirf owner aur admins hi terminal mode exit kar sakte hain." });
  }

  if (activeTerminals[sender]) {
    activeTerminals[sender].conn.end();
    delete activeTerminals[sender];
    return sock.sendMessage(jid, { text: "🚪 SSH Terminal mode exited." });
  } else {
    return sock.sendMessage(jid, { text: "⚠️ Aap terminal mode me nahi ho." });
  }
};

// ✅ Handle Input Commands
HANDLERS.terminalInput = async ({ sock, jid, sender, body, fromMe }) => {
  // Ignore bot's own messages in terminal mode
  if (fromMe) return;

  const session = activeTerminals[sender];
  if (!session) return; // Agar session hi nahi hai toh ignore karo

  const cmd = body.trim();
  if (!cmd) return;

  // 🛑 Ignore bot responses or duplicate triggers
  if (cmd.startsWith("💻") || cmd.startsWith("🚪") || cmd.startsWith("⚠️") || /^(```|[*_~])/.test(cmd)) {
    return;
  }

  const lowerCmd = cmd.toLowerCase();

  // 🔒 Agar user 'exit' likhe terminal ke andar
  if (lowerCmd === "exit") {
    return HANDLERS.exitterminal({ sock, jid, sender });
  }

  // ❌ Blocked commands
  const blocked = ["nano", "vim", "vi", "less", "top", "htop"];
  if (blocked.some(b => lowerCmd.startsWith(b))) {
    return sock.sendMessage(jid, {
      text: `⚠️ Yeh command allowed nahi hai: ${cmd.split(" ")[0]}`
    });
  }

  // 📂 Handle `cd` command
  if (lowerCmd.startsWith("cd ")) {
    const target = body.slice(3).trim();
    const remoteCmd = `cd "${session.cwd}" && cd "${target}" && pwd`;

    session.conn.exec(remoteCmd, (err, stream) => {
      if (err) {
        return sock.sendMessage(jid, { text: `❌ Error: ${err.message}` });
      }

      let output = "";
      stream.on("data", data => (output += data.toString()));
      stream.stderr.on("data", data => (output += data.toString()));

      stream.on("close", () => {
        output = output.trim();
        if (output.startsWith("/")) {
          session.cwd = output; // ✅ update cwd
          sock.sendMessage(jid, { text: `📂 Changed directory to: ${session.cwd}` });
        } else {
          sock.sendMessage(jid, { text: `❌ Directory not found: ${target}` });
        }
      });
    });
    return;
  }

  // 🚀 Execute other commands
  const remoteCmd = `cd "${session.cwd}" && ${body}`;
  session.conn.exec(remoteCmd, (err, stream) => {
    if (err) {
      return sock.sendMessage(jid, { text: `❌ Error: ${err.message}` });
    }

    let output = "";
    stream.on("data", data => (output += data.toString()));
    stream.stderr.on("data", data => (output += data.toString()));

    stream.on("close", () => {
      output = output.trim() || "⚠️ No output.";
      if (output.length > 3500) {
        output = output.slice(0, 3500) + "\n\n[Output truncated]";
      }

      sock.sendMessage(jid, {
        text: `💻 *Command Output*\n\`\`\`\n${output}\n\`\`\``
      });
    });
  });
};

HANDLERS.slist = async ({ sock, jid, sender }) => {
  if (!isOwner(sender)) return sock.sendMessage(jid, { text: "❌ Sirf owner hi `slist` chala sakta hai." });
  const adminsList = Object.keys(DB.admins || {}).join("\n") || "Koi admin nahi hai.";
  const ownersList = OWNER_JIDS.join("\n") || "Koi owner nahi hai.";
  const authorizedUsersList = Object.keys(DB.authorisedUsers || {}).join("\n") || "Koi authorised user nahi hai.";
  const authorizedGroupsList = Object.keys(DB.authorisedGroups || {}).join("\n") || "Koi authorised group nahi hai.";
  const msg = `👑 *Owners:*\n${ownersList}\n\n👮 *Admins:*\n${adminsList}\n\n✅ *Authorized Users:*\n${authorizedUsersList}\n\n📢 *Authorized Groups:*\n${authorizedGroupsList}`;
  return sock.sendMessage(jid, { text: msg });
};

// Block dangerous shell commands so bot doesn't hang/crash
const blockedShellCommands = ['nano', 'vi', 'vim', 'emacs', 'htop', 'top', 'less', 'man', 'shutdown', 'reboot'];
function isShellCommandBlocked(cmd) {
  if (!cmd) return false;
  const baseCmd = cmd.split(' ')[0].toLowerCase();
  return blockedShellCommands.includes(baseCmd);
}

HANDLERS.terminal = async ({ sock, jid, sender, args }) => {
  if (!isOwnerOrAdmin(sender)) return sock.sendMessage(jid, { text: "❌ Sirf owner aur admins hi `terminal` use kar sakte hain." });
  const cmd = args.join(" ");
  if (!cmd) return sock.sendMessage(jid, { text: `Usage: ${CONFIG.COMMAND_PREFIX}terminal <command>` });
  if (isShellCommandBlocked(cmd)) return sock.sendMessage(jid, { text: `⚠️ Bot is command ko support nahi karta: ${cmd.split(' ')[0]}` });
  
  exec(cmd, { timeout: 20 * 1000, maxBuffer: 1024 * 1024 }, async (error, stdout, stderr) => {
    if (error) return sock.sendMessage(jid, { text: `❌ Error: ${error.message}` });
    let output = stdout || stderr || "Koi output nahi mila.";
    if (output.length > 3800) output = output.slice(0, 3800) + "\n\n[Output truncated]";
    await sock.sendMessage(jid, { text: `💻 *Terminal Output*\n\`\`\`\n${output}\n\`\`\`` });
  });
};

// Group commands toggle OFF
// ------------------------- ⚙️ OFFGC / ONGC Handlers -------------------------
HANDLERS.offgc = async ({ sock, jid, sender, isGroup, isOwner, isAdmin }) => {
  if (!isOwner && !isAdmin) {
    return sock.sendMessage(jid, { text: '❌ Sirf owner aur admins hi `offgc` chala sakte hain.' });
  }
  if (!isGroup) {
    return sock.sendMessage(jid, { text: '❌ Ye command sirf group me chalta hai.' });
  }

  DB.offGroupCmds = DB.offGroupCmds || {};
  if (DB.offGroupCmds[jid]) {
    return sock.sendMessage(jid, { text: '⚠️ Is group me commands already disabled hain.' });
  }

  DB.offGroupCmds[jid] = true;
  await saveDB("offgc");
  logger.info(`Group commands disabled for ${jid} by ${sender}`);
  await sock.sendMessage(jid, { text: '✅ Group commands aur notifications disable kar diye gaye hain is group mein.' });
};

HANDLERS.ongc = async ({ sock, jid, sender, isGroup, isOwner, isAdmin }) => {
  if (!isOwner && !isAdmin) {
    return sock.sendMessage(jid, { text: '❌ Sirf owner aur admins hi `ongc` chala sakte hain.' });
  }
  if (!isGroup) {
    return sock.sendMessage(jid, { text: '❌ Ye command sirf group me chalta hai.' });
  }

  DB.offGroupCmds = DB.offGroupCmds || {};
  if (!DB.offGroupCmds[jid]) {
    return sock.sendMessage(jid, { text: '⚠️ Is group me commands already enabled hain.' });
  }

  delete DB.offGroupCmds[jid];
  await saveDB("ongc");
  logger.info(`Group commands enabled for ${jid} by ${sender}`);
  await sock.sendMessage(jid, { text: '✅ Group commands aur notifications enable kar diye gaye hain is group mein.' });
};

// ------------------------- ⚙️ OFFDM / ONDM Handlers -------------------------
HANDLERS.offdm = async ({ sock, jid, sender, isGroup, isOwner, isAdmin, args }) => {
  if (!isOwner && !isAdmin) {
    return sock.sendMessage(jid, { text: "❌ Sirf owner aur admins hi `offdm` chala sakte hain." });
  }

  // 🎯 Target JID (agar diya gaya ho toh usko, warna current sender)
  const target = args?.[0] || sender;

  // Group me ho toh jid dena mandatory
  if (isGroup && !args?.[0]) {
    return sock.sendMessage(jid, { text: "❌ Group se sirf specific JID ke liye hi disable kar sakte ho.\nUsage: offdm <jid>" });
  }

  DB.offDmCmds = DB.offDmCmds || {};
  if (DB.offDmCmds[target]) {
    return sock.sendMessage(jid, { text: `⚠️ DM commands already disabled for *${target}*.` });
  }

  DB.offDmCmds[target] = true;
  await saveDB("offdm");
  logger.info(`DM commands disabled for ${target}`);
  await sock.sendMessage(jid, { text: `✅ DM commands and notifications are disable for *${target}* .` });
};

HANDLERS.ondm = async ({ sock, jid, sender, isGroup, isOwner, isAdmin, args }) => {
  if (!isOwner && !isAdmin) {
    return sock.sendMessage(jid, { text: "❌ Only owner or admin can run this command." });
  }

  // 🎯 Target JID (agar diya gaya ho toh usko, warna current sender)
  const target = args?.[0] || sender;

  // Group me ho toh jid dena mandatory
  if (isGroup && !args?.[0]) {
    return sock.sendMessage(jid, { text: "❌ You can enable only specific jid in group.\nUsage: ondm <jid>" });
  }

  DB.offDmCmds = DB.offDmCmds || {};
  if (!DB.offDmCmds[target]) {
    return sock.sendMessage(jid, { text: `⚠️ DM commands already enabled for *${target}*.` });
  }

  delete DB.offDmCmds[target];
  await saveDB("ondm");
  logger.info(`DM commands enabled for ${target}`);
  await sock.sendMessage(jid, { text: `✅ DM commands and notifications are turned on for *${target}* .` });
};



  // AI Mode ON
HANDLERS.enteraimode = async ({ sock, jid, sender }) => {
    if (DB.aiModeUsers[sender]) {
        return await sock.sendMessage(jid, { text: '❌ You are already in AI mode!' });
    }
    DB.aiModeUsers[sender] = true;
    await saveDB("enteraimode");
    await sock.sendMessage(jid, { text: '✅ AI mode activated. Type freely; send exitaimode to stop.' });
};

// AI Mode OFF
HANDLERS.exitaimode = async ({ sock, jid, sender }) => {
    if (!DB.aiModeUsers[sender]) {
        return await sock.sendMessage(jid, { text: '❌ You are not in AI mode!' });
    }
    delete DB.aiModeUsers[sender];
    delete DB.aiChatHistory[sender];
    await saveDB("exitaimode");
    await sock.sendMessage(jid, { text: '✅ AI mode deactivated.' });
};

  // ------------ Admin Commands ------------
  HANDLERS.add = async ({ sock, jid, args, sender }) => {
  const normalizedSender = jidNormalizedUser(sender);
  if (!isOwnerOrAdmin(normalizedSender)) {
    return await sock.sendMessage(jid, { text: '❌ You are not the owner of the bot.' });
  }
  const userJid = args[0] ? jidNormalizedUser(args[0]) : null;
  if (!userJid) return await sock.sendMessage(jid, { text: `📖 Usage: ${CONFIG.COMMAND_PREFIX}add 91XXXXXXXXXX@s.whatsapp.net` });
  DB.authorisedUsers[userJid] = true;
  saveDB();
  await sock.sendMessage(jid, { text: `✅ User ${userJid} authorised.` });
};

HANDLERS.remove = async ({ sock, jid, args, sender }) => {
  const normalizedSender = jidNormalizedUser(sender);
  if (!isOwnerOrAdmin(normalizedSender)) {
    return await sock.sendMessage(jid, { text: '❌ You are not the owner of the bot.' });
  }
  const userJid = args[0] ? jidNormalizedUser(args[0]) : null;
  if (!userJid) return await sock.sendMessage(jid, { text: `📖 Usage: ${CONFIG.COMMAND_PREFIX}remove 91XXXXXXXXXX@s.whatsapp.net` });
  delete DB.authorisedUsers[userJid];
  saveDB();
  await sock.sendMessage(jid, { text: `✅ User ${userJid} removed from authorised list.` });
};


  HANDLERS.addgroup = async ({ sock, jid, sender, isGroup }) => {
  const normalizedSender = jidNormalizedUser(sender);

  // ❌ Agar DM hai toh block
  if (!isGroup) {
    return await sock.sendMessage(jid, { text: '❌ Yeh command sirf groups me use ki ja sakti hai.' });
  }

  const normalizedJid = jidNormalizedUser(jid);
  if (!isOwnerOrAdmin(normalizedSender)) {
    return await sock.sendMessage(jid, { text: '❌ You are not the owner or admin of the bot.' });
  }

  DB.authorisedGroups[normalizedJid] = true;
  saveDB();
  await sock.sendMessage(jid, { text: `✅ Group authorised.` });
};

HANDLERS.removegroup = async ({ sock, jid, sender, isGroup }) => {
  const normalizedSender = jidNormalizedUser(sender);

  // ❌ Agar DM hai toh block
  if (!isGroup) {
    return await sock.sendMessage(jid, { text: '❌ This command can be use in groups.' });
  }

  const normalizedJid = jidNormalizedUser(jid);
  if (!isOwnerOrAdmin(normalizedSender)) {
    return await sock.sendMessage(jid, { text: '❌ You are not the owner or admin of the bot.' });
  }

  delete DB.authorisedGroups[normalizedJid];
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

    if (warData?.isCwl) {
      // ✅ CWL only 1 attack
      status = used === 0 ? "(unused CWL attack)" : "(used CWL attack)";
    } else {
      // ✅ Normal wars 2 attacks
      status =
        used === 0 ? "(unused attacks in current war)" :
        used === 1 ? "(used 1 attack in current war)" :
        "(used 2 attacks in current war)";
    }
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
      if (warData?.isCwl) {
  msg += wm.attacks?.[0]
    ? `CWL Attack → vs ${warData.opponent.members.find(o => o.tag === wm.attacks[0].defenderTag)?.name || "Unknown"} → ${wm.attacks[0].destructionPercentage}% (${wm.attacks[0].stars}⭐)\n`
    : `CWL Attack → Unused\n`;
} else {
  msg += wm.attacks?.[0]
    ? `Attack 1 → vs ${warData.opponent.members.find(o => o.tag === wm.attacks[0].defenderTag)?.name || "Unknown"} → ${wm.attacks[0].destructionPercentage}% (${wm.attacks[0].stars}⭐)\n`
    : `Attack 1 → Unused\n`;

  msg += wm.attacks?.[1]
    ? `Attack 2 → vs ${warData.opponent.members.find(o => o.tag === wm.attacks[1].defenderTag)?.name || "Unknown"} → ${wm.attacks[1].destructionPercentage}% (${wm.attacks[1].stars}⭐)\n`
    : `Attack 2 → Unused\n`;
}
      msg += "\n";
    } else {
      msg += `🔥 Live War: [ leader hasn't selected this member to be in war ]\n\n`;
    }
  }

  // 🔥 After war ended / preparation
  else if (warState === "warEnded" || warState === "preparation") {
  const logs = DB.playerWarLogs?.[player.tag] || [];
  const maxAttacks = warData?.isCwl ? 1 : 2;
  const lastLogs = logs.filter(l => !l.isFromLive).slice(-maxAttacks);  // ✅ CWL fix

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
      const key = log.warId || `${log.clanTag}_${log.oppClanTag}`;
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

// Messages upsert handler
sock.ev.on('messages.upsert', async ({ messages }) => {
  try {
    // Parse incoming message
    const msg = messages?.[0];
    if (!msg || !msg.message) return; // Ignore empty messages

    const jid = msg.key.remoteJid;
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
 
 const isGroupChat = jid.endsWith('@g.us');

    // Extract text from message (handles text, captions, etc.)
    const getText = (msg) => {
      return (
        msg.message?.extendedTextMessage?.text ||
        msg.message?.conversation ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ''
      ).trim();
    };
    const text = getText(msg);
    if (!text) return; // Ignore empty text

// Normalize command
const cmdLower = text.trim().toLowerCase();

// --- Block terminal commands if offgc/offdm is enabled ---
if ((isGroupChat && DB.offGroupCmds[jid]) || (!isGroupChat && DB.offDmCmds[sender])) {
  if (cmdLower === "enterterminal" || cmdLower === "exitterminal" || activeTerminals[sender]) {
    return; // 🚫 silently block terminal commands
  }
}

// --- Terminal command handlers ---
if (cmdLower === "enterterminal") {
  return HANDLERS.enterterminal({ sock, jid, sender });
}

if (cmdLower === "exitterminal") {
  return HANDLERS.exitterminal({ sock, jid, sender });
}

if (activeTerminals[sender]) {
  return HANDLERS.terminalInput({ sock, jid, sender, body: text, fromMe: msg.key.fromMe });
}
    // Prefix logic
    const eatPrefix = (str) => {
      const p = CONFIG.COMMAND_PREFIX || '!';
      return p && str.startsWith(p) ? str.slice(p.length) : str;
    };
    const commandText = eatPrefix(text).toLowerCase();
    const parts = commandText.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    // Normalize JIDs for consistency
// Normalize JIDs for consistency
const normalizedJid = jidNormalizedUser(jid);
const normalizedSender = jidNormalizedUser(sender);

console.log('[DEBUG] Checking for JID:', normalizedJid, 'Sender:', normalizedSender);

const isOwnerFlag = isOwner(normalizedSender);
const isAdminFlag = isAdmin(normalizedSender);
const isAuthorizedForGroup = !!DB.authorisedGroups?.[normalizedJid];
const isAuthorizedForDM = !!DB.authorisedUsers?.[normalizedSender];

console.log('[DEBUG] isOwner:', isOwnerFlag, 'isAdmin:', isAdminFlag);
console.log('[DEBUG] Group Authorized:', isAuthorizedForGroup, 'DM Authorized:', isAuthorizedForDM);

    // Initialize DB objects
    DB = DB || {};
    DB.offGroupCmds = DB.offGroupCmds || {};
    DB.offDmCmds = DB.offDmCmds || {};
    DB.welcomedUsers = DB.welcomedUsers || {};
    DB.welcomedGroups = DB.welcomedGroups || {};
    DB.lastMessages = DB.lastMessages || {};
    DB.aiModeUsers = DB.aiModeUsers || {};
    DB.aiChatHistory = DB.aiChatHistory || {};

    // Logger for debugging
    const logger = {
      info: (msg) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
      error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, err)
    };

    // Cooldown management
    const cooldowns = {};
    const isOnCooldown = (sender, seconds = CONFIG.COOLDOWN_SEC || 5) => {
      const now = Date.now();
      return cooldowns[sender] && now < cooldowns[sender];
    };
    const setCooldown = (sender, seconds = CONFIG.COOLDOWN_SEC || 5) => {
      cooldowns[sender] = Date.now() + seconds * 1000;
    };

    // Async saveDB
    
// Fir baad me checks chalenge safely
if (isGroupChat && DB.offGroupCmds[jid]) {  
  if ((command === 'ongc') && (isOwnerFlag || isAdminFlag)) {  
    logger.info(`Allowing ongc for admin/owner ${sender} in group ${jid}`);  
  } else {  
    logger.info(`Commands blocked in group ${jid} due to offgc, including ${command}.`);  
    return;  
  }  
}  

if (!isGroupChat && DB.offDmCmds[sender]) {  
  if ((command === 'ondm') && (isOwnerFlag || isAdminFlag)) {  
    logger.info(`Allowing ondm for admin/owner ${sender} in DM`);  
  } else {  
    logger.info(`Commands blocked for DM ${sender} due to offdm, including ${command}.`);  
    return;  
  }  
}

    // Welcome messages
    if (!isGroupChat && !DB.welcomedUsers[sender]) {
      DB.welcomedUsers[sender] = true;
      await saveDB();
      await sock.sendMessage(jid, {
        text: `Hey there! I'm *${CONFIG.BOT_NAME || 'Bot'}* 🤖\n\nType *${CONFIG.COMMAND_PREFIX || '!'}help* to see what I can do!`
      });
    }
    if (isGroupChat && !DB.welcomedGroups[jid]) {
      DB.welcomedGroups[jid] = true;
      await saveDB();
      await sock.sendMessage(jid, {
        text: `Hey everyone! I'm *${CONFIG.BOT_NAME || 'Bot'}* 🤖\n\nType *${CONFIG.COMMAND_PREFIX || '!'}help* to see what I can do!`
      });
    }

    // Self-message handling
    if (msg.key.fromMe) {
      if (!OWNER_JIDS.includes(sender)) {
        logger.info(`Blocked non-owner self-message from ${sender}`);
        return;
      }
      if (DB.lastMessages[sender] === text) {
        logger.info(`Ignored repeated self-message from ${sender}`);
        return;
      }
      DB.lastMessages[sender] = text;
      await saveDB();
    }

// -------------------- 📥 Instagram Download --------------------
if (text.includes("instagram.com/")) {
  try {
    // ✅ Duplicate prevention
    globalThis.activeDownloads = globalThis.activeDownloads || {};
    if (globalThis.activeDownloads[msg.key.id]) return;
    globalThis.activeDownloads[msg.key.id] = true;

    await sock.sendMessage(jid, { text: "📥 Downloading your Instagram media, please wait..." });

    const outputDir = path.join(__dirname, "downloads");
    await fsp.mkdir(outputDir, { recursive: true });

    const filePrefix = path.join(outputDir, `${msg.key.id}`);
    const ytDlpCommand =
      process.platform === "win32"
        ? path.join(__dirname, "yt-dlp.exe")
        : path.join(__dirname, "yt-dlp");

    // 🔍 Already downloaded check
    const existing = (await fsp.readdir(outputDir)).filter((f) => f.startsWith(msg.key.id));
    if (existing.length > 0) {
      const filePath = path.join(outputDir, existing[0]);
      await sock.sendMessage(jid, { video: { url: filePath }, caption: "✅ Already downloaded!" });
      delete globalThis.activeDownloads[msg.key.id];
      return;
    }

    // ✅ Get metadata JSON first for better caption
    let caption = "Instagram Reel";
    try {
      const jsonMeta = await new Promise((resolve) => {
        execFile(
          ytDlpCommand,
          ["--dump-single-json", "--no-playlist", text],
          { cwd: __dirname, timeout: 30000 },
          (err, stdout) => {
            if (err) return resolve(null);
            try {
              resolve(JSON.parse(stdout));
            } catch {
              resolve(null);
            }
          }
        );
      });

      if (jsonMeta) {
        const title = jsonMeta.title || "Instagram Reel";
        const uploader = jsonMeta.uploader || "";
        const desc = jsonMeta.description ? `\n\n📝 ${jsonMeta.description}` : "";
        caption = `🎬 ${title}${uploader ? `\n👤 By ${uploader}` : ""}${desc}`;
      }
    } catch {
      caption = "Instagram Reel";
    }

    // ✅ Download media
    const cmdArgs = [
      "--cookies", "cookies.txt",
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--output", `${filePrefix}.%(ext)s`,
      "--no-playlist",
      text,
    ];

    await new Promise((resolve, reject) => {
      execFile(ytDlpCommand, cmdArgs, { cwd: __dirname, timeout: 180000 }, async (error) => {
        if (error) {
          logger.error(`yt-dlp error for ${text}:`, error);
          await sock.sendMessage(jid, { text: `❌ Failed to download: ${error.message}` });
          delete globalThis.activeDownloads[msg.key.id];
          return reject(error);
        }

        const files = (await fsp.readdir(outputDir)).filter((f) => f.startsWith(msg.key.id));
        if (files.length > 0) {
          const filePath = path.join(outputDir, files[0]);
          await sock.sendMessage(jid, {
            video: { url: filePath },
            caption,
          });

          // Cleanup temp file
          await fsp.unlink(filePath).catch((e) => logger.error("Cleanup error:", e));
          resolve();
        } else {
          await sock.sendMessage(jid, { text: "❌ Downloaded but file not found." });
          resolve();
        }

        delete globalThis.activeDownloads[msg.key.id];
      });
    });
  } catch (e) {
    logger.error(`Instagram download error for ${text}:`, e);
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
    delete globalThis.activeDownloads[msg.key.id];
  }
  return;
}

    // Permission checking
    async function checkCommandPermission({
  command,
  isGroupChat,
  jid,
  sender,
  isAuthorizedForGroup,
  isAuthorizedForDM,
  DB,
  sock,
  isOwner,
  isAdmin,
  freeCommands,
  cocCommands,
  adminCommands
}) {
  console.log('[DEBUG] Permission Check =>', {
    command,
    isGroupChat,
    jid,
    sender,
    isAuthorizedForGroup,
    isAuthorizedForDM,
    isOwner,
    isAdmin
  });
      const cmd = command.toLowerCase();
      const isFree = freeCommands.includes(cmd);
      const isCoc = cocCommands.includes(cmd);
      const isAdminCmd = adminCommands.includes(cmd);

      if (isFree) return true;
      if (isCoc) {
        if (isGroupChat) {
          if (!isAuthorizedForGroup) {
            await sock.sendMessage(jid, { text: '❌ This group is not authorized to use this command.' });
            return false;
          }
        } else {
          if (!isAuthorizedForDM) {
            await sock.sendMessage(jid, { text: '❌ You are not authorized to use this command in DM.' });
            return false;
          }
        }
        return true;
      }
      if (isAdminCmd) {
        if (!isOwner && !isAdmin) {
          await sock.sendMessage(jid, { text: '❌ You are not an admin.' });
          return false;
        }
        return true;
      }
      return false; // Unknown command
    }

    // Command execution
    const isKnown = Object.prototype.hasOwnProperty.call(HANDLERS, command);
    if (isKnown) {
      const permitted = await checkCommandPermission({
  command,
  isGroupChat,
  jid: normalizedJid,
  sender: normalizedSender,
  isAuthorizedForGroup,
  isAuthorizedForDM,
  DB,
  sock,
  isOwner: isOwnerFlag,
  isAdmin: isAdminFlag,
  freeCommands,
  cocCommands,
  adminCommands
});
      if (!permitted) return;

      if (!isOwnerFlag && isOnCooldown(sender)) {
        await sock.sendMessage(jid, { text: '⏳ Cooldown! Please wait before sending another command.' });
        return;
      }
      setCooldown(sender);

      try {
        await HANDLERS[command]({
  sock,
  jid: normalizedJid,
  sender: normalizedSender,
  args,
  isGroup: isGroupChat,
  isOwner: isOwnerFlag,
  isAdmin: isAdminFlag,
  isAuthorized: isAuthorizedForGroup || isAuthorizedForDM
});
      } catch (e) {
        console.error(`Command error: ${command}`, e); // Fallback to console.error
        await sock.sendMessage(jid, { text: `❌ Error running command: ${e.message}` });
      }
    // Create a temporary memory to track cooldown for owner
const ownerCooldown = new Set();

} else if (DB.aiModeUsers[sender]) {

    // ---- NEW: Owner-specific spam control with edit ----
    let sentMsg;
    if (isOwnerFlag) {
        if (ownerCooldown.has(sender)) {
            // Agar owner spam kar raha hai cooldown ke andar
            return;
        }
        ownerCooldown.add(sender);
        setTimeout(() => ownerCooldown.delete(sender), 500);

        // Send "Generating..." message and store ID for edit
        sentMsg = await sock.sendMessage(jid, { text: '🤖 Generating a response... ⏳' });
    } else {
        if (isOnCooldown(sender, CONFIG.AI_COOLDOWN_SEC || 10)) {
            await sock.sendMessage(jid, {
                text: `⏳ Please wait. (AI cooldown: ${CONFIG.AI_COOLDOWN_SEC || 10}s)`
            });
            return;
        }
        setCooldown(sender, CONFIG.AI_COOLDOWN_SEC || 10);

        // Non-owner bhi "generating" ka message dekhega
        sentMsg = await sock.sendMessage(jid, { text: '🤖 Generating a response... ⏳' });
    }
    // -----------------------------------------

    // Ensure chat history exists
    DB.aiChatHistory[sender] = DB.aiChatHistory[sender] || [
        {
            role: 'system',
content: `You are Saad's helpful bot named ${CONFIG.BOT_NAME || 'Bot'}. 
          Respond helpfully and conversationally.`
        }
    ];

    // Add user message
    DB.aiChatHistory[sender].push({ role: 'user', content: text });

    let aiResponse;
    try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${CONFIG.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/llama-4-maverick-17b-128e-instruct",
                messages: DB.aiChatHistory[sender],
                max_tokens: 500,
                temperature: 0.7
            })
        });

        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        aiResponse = data.choices?.[0]?.message?.content?.trim();
    } catch (err) {
        logger.error('AI error:', err);
        await sock.sendMessage(jid, {
            text: '❌ AI reply problem check your API.'
        });
        return;
    }

    if (!aiResponse || aiResponse.trim() === '') {
        await sock.sendMessage(jid, { text: '❌ AI reply is blank.' });
        return;
    }

    // Save assistant reply
    DB.aiChatHistory[sender].push({ role: 'assistant', content: aiResponse });
    await saveDB("aiModeResponse");

    // --- EDIT the existing message instead of sending new ---
    try {
        if (sentMsg?.key) {
            await sock.sendMessage(jid, { 
                edit: sentMsg.key, 
                text: aiResponse 
            });
        } else {
            // fallback if editing not supported
            await sock.sendMessage(jid, { text: aiResponse });
        }
    } catch (editErr) {
        logger.error('Message edit error:', editErr);
        await sock.sendMessage(jid, { text: aiResponse });
    }
}
  } catch (e) {
    logger.error('Message handler error:', e); // Use existing logger
  }
});

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

        // Filter existing logs that are NOT for current war, keep only old logs
        let oldLogs = DB.playerWarLogs[playerTag].filter(log => log.warId !== warId);

        // Prepare new logs for current war attacks
        let newLogs = [];

        for (const atk of attacks) {
          const warKey = `${warId}_${playerTag}_${atk.order}`;

          // Avoid duplicate logs for same war and order
          if (oldLogs.concat(newLogs).some(l => l.warKey === warKey)) continue;

          const opponentMember = warData.opponent?.members?.find(o => o.tag === atk.defenderTag);
          const opponentName = opponentMember?.name || "Unknown";

          newLogs.push({
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

          console.log(`✅ Prepared LIVE warlog for ${m.name}: ${atk.stars}⭐ vs ${opponentName}`);
        }

        // Save unused slots if any
const maxAttacks = warData?.isCwl ? 1 : 2;

for (let order = 1; order <= maxAttacks; order++) {
  if (!usedOrders.has(order)) {
    const warKey = `${warId}_${playerTag}_${order}`;

    if (oldLogs.concat(newLogs).some(l => l.warKey === warKey)) continue;

    newLogs.push({
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

    console.log(`⚪ Prepared UNUSED slot for ${m.name} (Attack ${order})`);
  }
}

        // Merge old logs with new current war logs, without removing old war logs
        DB.playerWarLogs[playerTag] = oldLogs.concat(newLogs);

        // Keep last 10 logs overall for player (old + new)
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

let isGetWarLogsRunning = false;

function runGetWarLogs() {
  if (isGetWarLogsRunning) {
    console.log("runGetWarLogs already running. Skipping this run.");
    return;
  }
  isGetWarLogsRunning = true;

  DB = loadDB();

  const clans = new Set(Object.values(DB.userClans)
    .map(c => (typeof c === "string" ? c : c.clanTag))
    .filter(Boolean));

  (async () => {
    for (const clanTag of clans) {
      try {
        const warData = await cocFetch(`/clans/${encodeURIComponent(clanTag)}/currentwar`);
        if (!warData || warData.state === "inWar") {
          console.log(`Skipping finalize for clan ${clanTag} as war state is: ${warData?.state}`);
          continue;
        }

        // Spawn getlogwar.js and wait for it to finish before continuing
        await new Promise((resolve, reject) => {
          const proc = spawn("node", ["getlogwar.js"], { stdio: "inherit" });
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`getlogwar.js exited with code ${code}`));
          });
          proc.on("error", reject);
        });

      } catch (e) {
        console.error(`Error while processing clan ${clanTag}: ${e.message}`);
      }
    }
    isGetWarLogsRunning = false;
  })();
}

// Run immediately
runGetWarLogs();
// Run every 3 minutes
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