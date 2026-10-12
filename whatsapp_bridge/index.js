const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

try {
  require("dotenv").config({ override: false });
} catch (e) {
  // In Docker / Portainer werden ENV-Variablen direkt geladen
}

// -------------------------------------------------------------
// Konfiguration
// -------------------------------------------------------------
const HA_URL = (process.env.HA_URL || "http://192.168.0.2:8123")
  .replace(/[\r\n]+/g, "")
  .trim()
  .replace(/\/+$/, "");
const HA_TOKEN = process.env.HA_TOKEN ? process.env.HA_TOKEN.replace(/[\r\n]+/g, "").trim() : "";

const WEBHOOK_PORT = Number(process.env.PORT || 3000);

const WAHA_URL = (process.env.WAHA_URL || "http://waha:3000")
  .replace(/[\r\n]+/g, "")
  .trim()
  .replace(/\/+$/, "");
const WAHA_API_KEY = process.env.WAHA_API_KEY ? process.env.WAHA_API_KEY.replace(/[\r\n]+/g, "").trim() : "";
const WAHA_SESSION = (process.env.WAHA_SESSION || "default").trim() || "default";
// Oeffentliche URL dieser Bridge, die WAHA als Webhook aufrufen soll.
// z.B. http://whatsapp-ha-bridge:3000/waha/webhook (Docker) oder http://192.168.0.2:3000/waha/webhook
const WAHA_WEBHOOK_URL = process.env.WAHA_WEBHOOK_URL ? process.env.WAHA_WEBHOOK_URL.replace(/[\r\n]+/g, "").trim() : "";

const ADMIN_NUMBER = process.env.ADMIN_NUMBER ? process.env.ADMIN_NUMBER.replace(/[^0-9]/g, "") : "";

let currentAgent = process.env.CONVERSATION_AGENT || null;
let currentStt = process.env.STT_ENGINE || null;

function haUrl(p) {
  return HA_URL + (p.startsWith("/") ? p : "/" + p);
}

function logHaError(tag, error) {
  const url = (error.config && error.config.url) || "(keine URL)";
  const status = error.response ? error.response.status : null;
  const data = error.response ? error.response.data : null;
  let answer = "";
  if (data) {
    const s = typeof data === "string" ? data : JSON.stringify(data);
    answer = " | Antwort: " + s.slice(0, 300);
  }
  console.error("[" + tag + "] " + (error.code || "") + " " + error.message + " | URL: " + url + (status ? " | HTTP " + status : "") + answer);
}

// -------------------------------------------------------------
// Adressbuecher (Format "ID:Name", am ersten Doppelpunkt trennen)
// -------------------------------------------------------------
function parseIdNameList(envValue) {
  const out = [];
  if (!envValue) return out;
  const entries = envValue.split(",");
  for (const entry of entries) {
    const idx = entry.indexOf(":");
    if (idx < 0) {
      console.warn('[Config] Ignoriere ungueltigen Eintrag (Format "ID:Name" erwartet): "' + entry.trim() + '"');
      continue;
    }
    const id = entry.slice(0, idx).trim();
    const name = entry.slice(idx + 1).trim();
    if (id && name) out.push({ id, name });
    else console.warn('[Config] Ignoriere ungueltigen Eintrag (Format "ID:Name" erwartet): "' + entry.trim() + '"');
  }
  return out;
}

const ALLOWED_USERS = [];
const ADDRESS_BOOK = {};
const NUMBER_TO_NAME = {};

for (const item of parseIdNameList(process.env.ALLOWED_USERS)) {
  const cleanNum = item.id.replace(/[^0-9]/g, "");
  const cleanName = item.name.toLowerCase();
  if (!cleanNum || !cleanName) continue;
  if (ADDRESS_BOOK[cleanName] && ADDRESS_BOOK[cleanName] !== cleanNum) {
    console.warn('[Config] Doppelter Name "' + item.name + '" - letzter Eintrag gewinnt.');
  }
  ALLOWED_USERS.push(cleanNum);
  ADDRESS_BOOK[cleanName] = cleanNum;
  NUMBER_TO_NAME[cleanNum] = item.name;
}

if (ADMIN_NUMBER && !ALLOWED_USERS.includes(ADMIN_NUMBER)) {
  ALLOWED_USERS.push(ADMIN_NUMBER);
}

const GROUP_BOOK = {};
for (const item of parseIdNameList(process.env.GROUP_IDS)) {
  if (!item.id.toLowerCase().endsWith("@g.us")) {
    console.warn('[Config] Ignoriere Gruppen-Eintrag ohne @g.us-JID: "' + item.id + '"');
    continue;
  }
  const cleanName = item.name.toLowerCase();
  if (GROUP_BOOK[cleanName] && GROUP_BOOK[cleanName] !== item.id) {
    console.warn('[Config] Doppelter Gruppenname "' + item.name + '" - letzter Eintrag gewinnt.');
  }
  GROUP_BOOK[cleanName] = item.id;
}

const userConversations = {};

// Empfaenger (Name, Nummer oder JID) -> WAHA chatId.
// Personen: 436...@c.us (altes @s.whatsapp.net wird automatisch gemappt), Gruppen: ...@g.us
function resolveTargetChatId(recipient) {
  const raw = String(recipient || "").trim();
  const clean = raw.toLowerCase().trim();
  if (!clean) return null;
  if (clean.endsWith("@g.us")) return raw;
  if (clean.endsWith("@c.us") || clean.endsWith("@s.whatsapp.net")) {
    return raw.replace(/@s\.whatsapp\.net$/i, "@c.us");
  }
  if (clean.endsWith("@lid")) {
    console.warn('[Senden] LID-Adresse ohne Telefonnummer kann nicht zugestellt werden: "' + raw + '"');
    return null;
  }
  if (GROUP_BOOK[clean]) return GROUP_BOOK[clean];
  const targetNumber = ADDRESS_BOOK[clean];
  if (targetNumber) return targetNumber + "@c.us";
  if (/^\+?\d+$/.test(clean)) return clean.replace(/^\+/, "") + "@c.us";
  return null;
}

// Telefonnummer aus WAHA chatId/participant extrahieren (nur @c.us / @s.whatsapp.net).
function phoneFromChatId(chatId) {
  if (!chatId) return null;
  const parts = String(chatId).split("@");
  const user = parts[0];
  const server = parts[1];
  if (!user || !server) return null;
  if (server === "c.us" || server === "s.whatsapp.net") {
    const digits = user.split(":")[0].replace(/[^0-9]/g, "");
    return digits || null;
  }
  return null;
}

// -------------------------------------------------------------
// LID -> Telefonnummer Aufloesung
// WhatsApp schickt seit der LID-Privatsphaere-Umstellung oft nur noch
// eine anonyme @lid-ID statt der Telefonnummer. Die echte Nummer steht
// in WAHAs Kontakt-/Chatdaten (Felder id/phoneNumber) und wird hier
// pro LID einmal abgefragt und dann im Speicher gecacht.
// -------------------------------------------------------------
const lidToPhoneCache = {};

function lidUserOf(chatId) {
  const s = String(chatId || "");
  if (!s.toLowerCase().endsWith("@lid")) return null;
  return s.split("@")[0].split(":")[0] || null;
}

function phoneFromWahaContact(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.phoneNumber,
    obj.number,
    obj.id,
    obj.chatId,
    obj.jid,
    obj.notifyName === undefined ? null : null,
  ];
  // Verschachtelte Kontakt-Objekte (je nach Engine) mitpruefen.
  const nested = [obj.contact, obj.chat, obj.sender].filter(Boolean);
  for (const n of nested) {
    candidates.push(n.phoneNumber, n.number, n.id, n.chatId, n.jid);
  }
  for (const c of candidates) {
    const num = phoneFromChatId(c);
    if (num) return num;
  }
  return null;
}

async function resolveLidToPhone(lidUser) {
  if (!lidUser) return null;
  if (lidToPhoneCache[lidUser]) return lidToPhoneCache[lidUser];
  const lid = lidUser + "@lid";
  // 1) Direkter Kontakt-Lookup.
  const contactPaths = [
    "/api/" + encodeURIComponent(WAHA_SESSION) + "/contacts/" + encodeURIComponent(lid),
    "/api/contacts/" + encodeURIComponent(lid) + "?session=" + encodeURIComponent(WAHA_SESSION),
  ];
  for (const p of contactPaths) {
    try {
      const res = await waha.get(p);
      const num = phoneFromWahaContact(res.data);
      if (num) {
        lidToPhoneCache[lidUser] = num;
        console.log("[LID] " + lid + " -> " + num + " (Kontakt-Lookup)");
        return num;
      }
    } catch (e) {
      if (!e.response || (e.response.status !== 404 && e.response.status !== 405)) {
        console.warn("[LID] Kontakt-Lookup fehlgeschlagen (" + p + "): " + e.message);
      }
    }
  }
  // 2) Fallback: Kontaktliste durchsuchen (gecacht pro Bridge-Laufzeit via einmaligem Scan).
  try {
    const listPaths = [
      "/api/" + encodeURIComponent(WAHA_SESSION) + "/contacts?limit=1000",
      "/api/contacts?session=" + encodeURIComponent(WAHA_SESSION) + "&limit=1000",
    ];
    for (const p of listPaths) {
      try {
        const res = await waha.get(p);
        const list = Array.isArray(res.data) ? res.data : res.data.contacts || res.data.data || [];
        for (const c of list) {
          const num = phoneFromWahaContact(c);
          const lids = [c.lid, c.contact && c.contact.lid].filter(Boolean).map(String);
          for (const l of lids) {
            const u = l.split("@")[0];
            if (u && num && !lidToPhoneCache[u]) lidToPhoneCache[u] = num;
          }
        }
        if (lidToPhoneCache[lidUser]) {
          console.log("[LID] " + lid + " -> " + lidToPhoneCache[lidUser] + " (Listen-Scan)");
          return lidToPhoneCache[lidUser];
        }
        break;
      } catch (e) {
        if (!e.response || (e.response.status !== 404 && e.response.status !== 405)) throw e;
      }
    }
  } catch (e) {
    console.warn("[LID] Listen-Scan fehlgeschlagen: " + e.message);
  }
  return null;
}

async function resolveSenderNumber(senderRaw, payload) {
  // 1) Klassischer Fall: echte Nummer in der Adresse.
  const direct = phoneFromChatId(senderRaw);
  if (direct) return direct;
  // 2) WAHA liefert die Nummer manchmal in Zusatzfeldern des Events.
  const extraFields = [
    payload && payload.senderNumber,
    payload && payload.participantPhoneNumber,
    payload && payload.authorPhoneNumber,
    payload && payload.fromPhoneNumber,
    payload && payload.remoteJidAlt,
    payload && payload.participantAlt,
  ];
  for (const f of extraFields) {
    const num = phoneFromChatId(f);
    if (num) return num;
  }
  // 3) LID ueber WAHA-Kontakte aufloesen.
  const lidUser = lidUserOf(senderRaw);
  if (lidUser) {
    return await resolveLidToPhone(lidUser);
  }
  return null;
}

// -------------------------------------------------------------
// WAHA Client
// -------------------------------------------------------------
const waha = axios.create({
  baseURL: WAHA_URL,
  timeout: 30000,
  headers: WAHA_API_KEY ? { "X-Api-Key": WAHA_API_KEY } : {},
});

async function ensureWahaSession() {
  if (!WAHA_API_KEY) {
    console.warn("[WAHA] Kein WAHA_API_KEY gesetzt - bitte in der Konfiguration hinterlegen.");
  }
  try {
    const res = await waha.get("/api/sessions/" + encodeURIComponent(WAHA_SESSION));
    console.log('[WAHA] Session "' + WAHA_SESSION + '": ' + (res.data && res.data.status ? res.data.status : "unbekannt"));
    if (res.data && res.data.status === "SCAN_QR_CODE") {
      console.log("[WAHA] QR-Code scannen: " + WAHA_URL + "/dashboard oder GET " + WAHA_URL + "/api/" + WAHA_SESSION + "/auth/qr");
    }
    await ensureWahaWebhook();
    return res.data;
  } catch (e) {
    if (e.response && e.response.status === 404) {
      console.log('[WAHA] Lege Session "' + WAHA_SESSION + '" an ...');
      try {
        const body = { name: WAHA_SESSION, start: true };
        if (WAHA_WEBHOOK_URL) {
          body.config = {
            webhooks: [{ url: WAHA_WEBHOOK_URL, events: ["message", "poll.vote", "session.status"] }],
          };
        }
        const created = await waha.post("/api/sessions", body);
        console.log("[WAHA] Session angelegt: " + (created.data && created.data.status ? created.data.status : "OK"));
        console.log("[WAHA] QR-Code scannen: " + WAHA_URL + "/dashboard oder GET " + WAHA_URL + "/api/" + WAHA_SESSION + "/auth/qr");
        return created.data;
      } catch (createErr) {
        const detail = createErr.response && createErr.response.data ? JSON.stringify(createErr.response.data).slice(0, 500) : createErr.message;
        console.error("[WAHA] Session konnte nicht angelegt werden: " + detail);
      }
    } else {
      console.error("[WAHA] Nicht erreichbar (" + WAHA_URL + "): " + (e.code || "") + " " + e.message);
    }
    return null;
  }
}

// WAHA braucht beim gemeinsamen Start oft laenger als die Bridge
// (Chromium-Engine, Session-Store). Darum mit Backoff erneut versuchen,
// statt nur einmal beim Start zu pruefen.
async function ensureWahaSessionWithRetry(attempts, delayMs) {
  for (let i = 1; i <= attempts; i++) {
    const session = await ensureWahaSession();
    if (session) {
      if (i > 1) console.log("[WAHA] Nach " + i + ". Versuch verbunden.");
      return session;
    }
    if (i < attempts) {
      console.log("[WAHA] Erneuter Versuch in " + Math.round(delayMs / 1000) + "s (" + i + "/" + attempts + ") ...");
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 60000);
    }
  }
  console.error("[WAHA] Nach " + attempts + " Versuchen weiterhin nicht erreichbar - pruefe ob der WAHA-Container laeuft (docker ps) und WAHA_URL stimmt.");
  return null;
}

async function ensureWahaWebhook() {
  if (!WAHA_WEBHOOK_URL) {
    console.warn("[WAHA] Keine WAHA_WEBHOOK_URL gesetzt - Webhook muss manuell im Dashboard auf /waha/webhook zeigen.");
    return;
  }
  try {
    const res = await waha.get("/api/sessions/" + encodeURIComponent(WAHA_SESSION));
    const known = JSON.stringify((res.data && res.data.config) || {}).includes(WAHA_WEBHOOK_URL);
    if (known) return;
    const prevHooks = (res.data && res.data.config && res.data.config.webhooks) || [];
    await waha.put("/api/sessions/" + encodeURIComponent(WAHA_SESSION), {
      config: Object.assign({}, (res.data && res.data.config) || {}, {
        webhooks: prevHooks.concat([{ url: WAHA_WEBHOOK_URL, events: ["message", "poll.vote", "session.status"] }]),
      }),
    });
    console.log("[WAHA] Webhook registriert: " + WAHA_WEBHOOK_URL);
  } catch (e) {
    const code = (e.response && e.response.status) || e.message;
    console.warn("[WAHA] Webhook konnte nicht automatisch gesetzt werden (" + code + "). Bitte im Dashboard manuell auf " + WAHA_WEBHOOK_URL + " zeigen.");
  }
}

async function wahaSessionStatus() {
  try {
    const res = await waha.get("/api/sessions/" + encodeURIComponent(WAHA_SESSION));
    return res.data;
  } catch (e) {
    return null;
  }
}

async function sendWahaText(chatId, text) {
  await waha.post("/api/sendText", { session: WAHA_SESSION, chatId, text });
}

async function sendWahaPoll(chatId, name, options) {
  await waha.post("/api/sendPoll", {
    session: WAHA_SESSION,
    chatId,
    poll: { name, options, multipleAnswers: false },
  });
}

// -------------------------------------------------------------
// Home Assistant: Conversation + STT
// -------------------------------------------------------------
async function fetchAvailableAgents() {
  try {
    const res = await axios.get(haUrl("/api/states"), {
      headers: { Authorization: "Bearer " + HA_TOKEN },
    });
    return res.data
      .filter((e) => e.entity_id.startsWith("conversation."))
      .map((e) => "- `" + e.entity_id + "` (" + (e.attributes.friendly_name || e.entity_id) + ")");
  } catch (e) {
    return ["Fehler beim Abrufen der Agenten aus Home Assistant."];
  }
}

async function transcribeWahaMedia(mediaUrl) {
  if (!currentStt) {
    console.error("[HA STT] Keine STT_ENGINE aktiv.");
    return null;
  }
  const absoluteUrl = mediaUrl.startsWith("http") ? mediaUrl : WAHA_URL + (mediaUrl.startsWith("/") ? mediaUrl : "/" + mediaUrl);
  const uniqueId = Date.now();
  const tmpInPath = path.join(__dirname, "tmp_" + uniqueId + ".bin");
  const tmpWavPath = path.join(__dirname, "tmp_" + uniqueId + ".wav");
  try {
    const dl = await axios.get(absoluteUrl, {
      headers: WAHA_API_KEY ? { "X-Api-Key": WAHA_API_KEY } : {},
      responseType: "arraybuffer",
      timeout: 60000,
    });
    fs.writeFileSync(tmpInPath, Buffer.from(dl.data));

    execSync('ffmpeg -y -i "' + tmpInPath + '" -ar 16000 -ac 1 -c:a pcm_s16le "' + tmpWavPath + '"', { stdio: "ignore" });
    const wavBuffer = fs.readFileSync(tmpWavPath);

    const response = await axios.post(haUrl("/api/stt/" + currentStt), wavBuffer, {
      headers: {
        Authorization: "Bearer " + HA_TOKEN,
        "Content-Type": "audio/wav",
        "X-Speech-Content": "language=de; format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1",
      },
    });

    if (response.data && response.data.result === "success") {
      return response.data.text;
    }
    console.error("[HA STT] Unerwartetes Antwortformat:", response.data);
    return null;
  } catch (error) {
    console.error("[HA STT] Fehler bei der Transkription:", (error.response && error.response.data) || error.message);
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpInPath)) fs.unlinkSync(tmpInPath);
      if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
    } catch (e) {}
  }
}

async function askHomeAssistant(senderNumber, pushName, text) {
  const payload = { text: "[Absender: " + pushName + "] " + text, language: "de" };
  if (currentAgent) payload.agent_id = currentAgent;
  if (userConversations[senderNumber]) payload.conversation_id = userConversations[senderNumber];

  const haResponse = await axios.post(haUrl("/api/conversation/process"), payload, {
    headers: { Authorization: "Bearer " + HA_TOKEN, "Content-Type": "application/json" },
  });

  if (haResponse.data && haResponse.data.conversation_id) {
    userConversations[senderNumber] = haResponse.data.conversation_id;
  }
  return (haResponse.data && haResponse.data.response && haResponse.data.response.speech && haResponse.data.response.speech.plain && haResponse.data.response.speech.plain.speech) || "Befehl ausgeführt.";
}

// -------------------------------------------------------------
// Eingehende WAHA-Events
// -------------------------------------------------------------
async function handleIncomingMessage(payload) {
  const chatId = payload.from || payload.chatId || "";
  const fromMe = Boolean(payload.fromMe);
  if (!chatId || fromMe) return;

  const isGroup = String(chatId).endsWith("@g.us");
  const senderRaw = isGroup ? payload.participant || payload.author || "" : chatId;
  const senderNumber = await resolveSenderNumber(senderRaw, payload);
  // Antworten gehen immer an die Original-Adresse zurueck (LID bleibt LID),
  // nur die Berechtigungspruefung laeuft ueber die aufgeloeste Nummer.
  const replyChatId = chatId;

  const pushName =
    payload.senderName || payload.pushName || (senderNumber && NUMBER_TO_NAME[senderNumber]) || "Unbekannt";

  if (!senderNumber) {
    console.log("[Zugriff verweigert] Absender nicht aufloesbar (chat:" + chatId + " participant:" + (senderRaw || "?") + " Name:" + pushName + ")");
    return;
  }

  if (isGroup && Object.keys(GROUP_BOOK).length > 0 && !Object.values(GROUP_BOOK).includes(chatId)) {
    console.log("[Gruppe ignoriert] " + chatId + " ist nicht in GROUP_IDS eingetragen.");
    return;
  }

  if (!ALLOWED_USERS.includes(senderNumber)) {
    console.log("[Zugriff verweigert] Nummer: " + senderNumber + " (Name:" + pushName + ")");
    return;
  }

  let text = payload.body || payload.text || payload.caption || "";
  if (typeof text !== "string") text = "";
  const hasMedia = Boolean(payload.hasMedia);
  const media = payload.media || null;
  const mimetype = media ? media.mimetype || "" : "";
  const isAudioHint =
    /audio|voice|ptt|ogg|opus|mp3/i.test(mimetype) ||
    Boolean(payload.isVoice || payload.isPtt || payload.type === "ptt");

  if (!text.trim() && hasMedia && media && media.url && (isAudioHint || !mimetype)) {
    console.log("[Audio empfangen] Transkribiere Sprachnachricht von " + pushName + " ...");
    text = (await transcribeWahaMedia(media.url)) || "";
    if (!text) {
      await sendWahaText(replyChatId, "Fehler: Sprachnachricht konnte nicht transkribiert werden.");
      return;
    }
  }

  // Reine Bilder/Dateien ohne Text ignorieren.
  if (!text.trim()) return;

  const isAdmin = ADMIN_NUMBER && senderNumber === ADMIN_NUMBER;
  let cleanCmd = text.trim().toLowerCase();
  if (cleanCmd === "1") cleanCmd = "!reset";
  if (cleanCmd === "2") cleanCmd = "/status";
  if (cleanCmd === "3") cleanCmd = "/help";

  if (cleanCmd === "!reset" || cleanCmd === "/reset" || cleanCmd === "cmd_reset" || cleanCmd.includes("verlauf zuruecksetzen") || cleanCmd.includes("verlauf zurücksetzen")) {
    delete userConversations[senderNumber];
    await sendWahaText(replyChatId, "Dein Gespraechsverlauf wurde zurueckgesetzt.");
    return;
  }

  if (cleanCmd === "/help" || cleanCmd === "!help" || cleanCmd === "hilfe" || cleanCmd.includes("hilfe")) {
    let helpMsg =
      "Home Assistant WhatsApp-Bot\n\n" +
      "- Steuerung: Schreibe oder sprich einfache Sprachbefehle.\n" +
      "- `1` oder `!reset` - Gespraechsverlauf zuruecksetzen.\n" +
      "- `2` oder `/status` - System-Informationen.\n" +
      "- `/ping` - Bot-Erreichbarkeit & Laufzeit.\n" +
      "- `/whoami` - Eigene Benutzerinfo.";
    if (isAdmin) {
      helpMsg +=
        "\n\nAdmin-Befehle:\n" +
        "- `/setagent [id]` - Agent setzen oder alle anzeigen\n" +
        "- `/setstt [id]` - STT-Engine setzen oder anzeigen\n" +
        "- `/groups` - Gruppen mit IDs auflisten\n" +
        "- `/restart` - Bot neu starten";
    }
    await sendWahaText(replyChatId, helpMsg);
    return;
  }

  if (cleanCmd === "/status") {
    const wahaStatus = await wahaSessionStatus();
    await sendWahaText(
      chatId,
      "System Status\n\n" +
        "- Home Assistant: " + HA_URL + "\n" +
        "- STT Engine: " + (currentStt || "Nicht aktiv") + "\n" +
        "- Aktiver Agent: " + (currentAgent || "Default") + "\n" +
        "- WAHA Session: " + ((wahaStatus && wahaStatus.status) || "unbekannt") + "\n" +
        "- Admin-Modus: " + (isAdmin ? "Aktiv (" + senderNumber + ")" : "Nein") + "\n" +
        "- Aktive Session: " + (userConversations[senderNumber] ? "Ja" : "Nein")
    );
    return;
  }

  if (cleanCmd === "/ping") {
    const uptimeSeconds = Math.floor(process.uptime());
    await sendWahaText(replyChatId, "Pong! Bot laeuft stabil.\nLaufzeit: " + uptimeSeconds + " Sekunden");
    return;
  }

  if (cleanCmd === "/whoami") {
    await sendWahaText(replyChatId, "Dein Profil\n\n- Name: " + pushName + "\n- Nummer: " + senderNumber + "\n- Admin: " + (isAdmin ? "Ja" : "Nein"));
    return;
  }

  if (cleanCmd.startsWith("/setagent")) {
    if (!isAdmin) {
      await sendWahaText(replyChatId, "Dieser Befehl ist nur dem Administrator vorbehalten.");
      return;
    }
    const newAgent = text.replace("/setagent", "").trim();
    if (!newAgent) {
      const agents = await fetchAvailableAgents();
      await sendWahaText(replyChatId, "Verfuegbare Conversation Agents in HA:\nAktuell aktiv: `" + (currentAgent || "Default") + "`\n\n" + agents.join("\n") + "\n\nNutze: `/setagent <entity_id>`");
    } else {
      currentAgent = newAgent;
      await sendWahaText(replyChatId, "Konversations-Agent geaendert zu:\n`" + currentAgent + "`");
    }
    return;
  }

  if (cleanCmd.startsWith("/setstt")) {
    if (!isAdmin) {
      await sendWahaText(replyChatId, "Dieser Befehl ist nur dem Administrator vorbehalten.");
      return;
    }
    const newStt = text.replace("/setstt", "").trim();
    if (!newStt) {
      await sendWahaText(replyChatId, "STT Engine\nAktuell aktiv: `" + (currentStt || "Nicht aktiv") + "`\n\nGib den Namen der Engine ein (z. B. `/setstt stt.faster_whisper`).");
    } else {
      currentStt = newStt;
      await sendWahaText(replyChatId, "STT-Engine geaendert zu:\n`" + currentStt + "`");
    }
    return;
  }

  if (cleanCmd === "/groups") {
    if (!isAdmin) {
      await sendWahaText(replyChatId, "Dieser Befehl ist nur dem Administrator vorbehalten.");
      return;
    }
    try {
      const res = await waha.get("/api/" + encodeURIComponent(WAHA_SESSION) + "/groups?limit=100");
      const list = res.data || [];
      if (!list.length) {
        await sendWahaText(replyChatId, "Der Bot ist in keiner Gruppe.");
      } else {
        const lines = list.slice(0, 30).map((g) => "- " + (g.subject || g.name || "?") + "\n  `" + g.id + "`");
        await sendWahaText(replyChatId, "Gruppen des Bots (" + list.length + "):\n\n" + lines.join("\n") + "\n\nNutze die ID als Empfaenger oder trage sie in GROUP_IDS ein.");
      }
    } catch (e) {
      await sendWahaText(replyChatId, "Fehler beim Abrufen der Gruppen: " + e.message);
    }
    return;
  }

  if (cleanCmd === "/restart") {
    if (!isAdmin) {
      await sendWahaText(replyChatId, "Dieser Befehl ist nur dem Administrator vorbehalten.");
      return;
    }
    await sendWahaText(replyChatId, "Bot wird im Admin-Auftrag neu gestartet...");
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  if (cleanCmd === "/menu") {
    await sendWahaText(replyChatId, "Hauptmenue\n\nWähle eine Option (einfach Zahl senden):\n\n1. Verlauf zuruecksetzen\n2. System Status\n3. Hilfe anzeigen");
    return;
  }

  console.log('[Nachricht empfangen] Von ' + pushName + ' (' + senderNumber + '): "' + text + '"');
  try {
    const responseText = await askHomeAssistant(senderNumber, pushName, text);
    await sendWahaText(replyChatId, responseText);
  } catch (error) {
    logHaError("HA Conversation", error);
    await sendWahaText(replyChatId, "Fehler bei der Verarbeitung in Home Assistant.");
  }
}

// -------------------------------------------------------------
// HTTP-Server: HA -> WhatsApp (kompatibel wie bisher) + WAHA-Webhook
// -------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", async (req, res) => {
  const status = await wahaSessionStatus();
  res.json({ ok: true, waha: WAHA_URL, session: WAHA_SESSION, status: (status && status.status) || "unknown" });
});

// WAHA ruft diesen Endpoint pro Event auf.
app.post("/waha/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const event = body.event;
    const payload = body.payload || {};
    const session = body.session;
    if (session && session !== WAHA_SESSION) {
      return res.json({ ok: true, ignored: "fremde Session" });
    }
    if (event === "message") {
      await handleIncomingMessage(payload);
    } else if (event === "poll.vote") {
      const vote = payload.vote || payload || {};
      console.log("[Poll-Vote] " + JSON.stringify(vote).slice(0, 300));
    } else if (event === "session.status") {
      console.log("[WAHA] Session-Status: " + (payload.status || JSON.stringify(payload).slice(0, 200)));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[Webhook] Fehler:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-message", async (req, res) => {
  const body = req.body || {};
  const message = body.message;
  const recipient = body.recipient;
  if (!message) return res.status(400).json({ error: "Keine Nachricht angegeben." });
  if (!recipient) return res.status(400).json({ error: "Kein Empfaenger angegeben." });
  try {
    const chatId = resolveTargetChatId(recipient);
    if (!chatId) return res.status(404).json({ error: 'Empfaenger "' + recipient + '" nicht gefunden.' });
    await sendWahaText(chatId, message);
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Senden via WAHA:", (err.response && err.response.data) || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/send-poll", async (req, res) => {
  const body = req.body || {};
  const title = body.title;
  const options = body.options;
  const recipient = body.recipient;
  if (!title || !options || !Array.isArray(options)) {
    return res.status(400).json({ error: "Titel und ein Array von 'options' sind erforderlich." });
  }
  if (!recipient) return res.status(400).json({ error: "Kein Empfaenger angegeben." });
  try {
    const chatId = resolveTargetChatId(recipient);
    if (!chatId) return res.status(404).json({ error: 'Empfaenger "' + recipient + '" nicht gefunden.' });
    await sendWahaPoll(chatId, title, options);
    res.json({ success: true, message: "Umfrage erfolgreich gesendet." });
  } catch (err) {
    console.error("Fehler beim Senden der Umfrage via WAHA:", (err.response && err.response.data) || err.message);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Start
// -------------------------------------------------------------
(async () => {
  console.log("[HA] URL: " + HA_URL + " | Token: " + (HA_TOKEN ? "gesetzt" : "FEHLT!"));
  console.log("[WAHA] URL: " + WAHA_URL + " | Session: " + WAHA_SESSION + " | Webhook: " + (WAHA_WEBHOOK_URL || "(nicht gesetzt)"));
  try {
    const res = await axios.get(haUrl("/api/"), {
      headers: HA_TOKEN ? { Authorization: "Bearer " + HA_TOKEN } : {},
      timeout: 10000,
    });
    console.log("[HA] Erreichbar: " + ((res.data && res.data.message) || "OK"));
  } catch (error) {
    logHaError("HA Check", error);
  }
  await ensureWahaSessionWithRetry(10, 5000);
})();

app.listen(WEBHOOK_PORT, () => {
  console.log("WhatsApp-Bridge (WAHA-Modus) laeuft auf Port " + WEBHOOK_PORT);
  console.log("WAHA-Webhook: POST /waha/webhook");
});
