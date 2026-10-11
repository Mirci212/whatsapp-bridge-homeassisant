const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const express = require("express");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

try {
  require("dotenv").config({ override: false });
} catch (e) {
  // In Docker / Portainer werden ENV-Variablen direkt geladen
}

// HA_URL normalisieren: \r/Whitespace (CRLF-.env!) und trailing Slashes killen,
// sonst baut axios "Invalid URL" (z.B. "http://host:8123\r/api/...").
const HA_URL = (process.env.HA_URL || "http://192.168.0.2:8123").replace(/[\r\n]+/g, "").trim().replace(/\/+$/, "");
const HA_TOKEN = process.env.HA_TOKEN?.replace(/[\r\n]+/g, "").trim();

function haUrl(p) {
  return `${HA_URL}${p.startsWith("/") ? p : "/" + p}`;
}

function logHaError(tag, error) {
  const url = error.config?.url || error.request?.path || "(keine URL)";
  const status = error.response?.status;
  const data = error.response?.data;
  console.error(`[${tag}] ${error.code || ""} ${error.message} | URL: ${url}${status ? ` | HTTP ${status}` : ""}${data ? ` | Antwort: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}` : ""}`);
}

// Beim Start einmal HA-Erreichbarkeit prüfen (fail fast mit Klartext statt später "Invalid URL")
(async () => {
  console.log(`[HA] URL: ${HA_URL} | Token: ${HA_TOKEN ? "gesetzt" : "FEHLT!"}`);
  try {
    const res = await axios.get(haUrl("/api/"), {
      headers: HA_TOKEN ? { Authorization: `Bearer ${HA_TOKEN}` } : {},
      timeout: 10000,
    });
    console.log(`[HA] Erreichbar: ${res.data?.message || "OK"}`);
  } catch (error) {
    logHaError("HA Check", error);
  }
})();
const WEBHOOK_PORT = process.env.PORT || 3000;

// Admin-Nummer bereinigen (nur Ziffern)
const ADMIN_NUMBER = process.env.ADMIN_NUMBER ? process.env.ADMIN_NUMBER.replace(/[^0-9]/g, "") : "";

// Dynamische Laufzeit-Variablen
let currentAgent = process.env.CONVERSATION_AGENT || null;
let currentStt = process.env.STT_ENGINE || null;

// -------------------------------------------------------------
// Persistenter Speicher: im HA Add-on ist nur /data persistent,
// /app wird bei Update/Neustart gewiped -> Session-Key ging verloren.
// -------------------------------------------------------------
const AUTH_DIR = fs.existsSync("/data") ? "/data/auth_info_baileys" : path.join(__dirname, "auth_info_baileys");

// Einheitlicher Parser für "ID:Name"-Listen (am ersten Doppelpunkt trennen).
// ALLOWED_USERS="436...:Marco,43...:Brigitte", GROUP_IDS="120363...@g.us:Familie"
function parseIdNameList(envValue) {
  const out = [];
  if (!envValue) return out;
  for (const entry of envValue.split(",")) {
    const idx = entry.indexOf(":");
    if (idx < 0) {
      console.warn(`[Config] Ignoriere ungültigen Eintrag (Format "ID:Name" erwartet): "${entry.trim()}"`);
      continue;
    }
    const id = entry.slice(0, idx).trim();
    const name = entry.slice(idx + 1).trim();
    if (id && name) out.push({ id, name });
    else console.warn(`[Config] Ignoriere ungültigen Eintrag (Format "ID:Name" erwartet): "${entry.trim()}"`);
  }
  return out;
}

// Parsing der ALLOWED_USERS (Format: "Nummer:Name")
const ALLOWED_USERS = [];
const ADDRESS_BOOK = {};
const NUMBER_TO_NAME = {};

for (const { id, name } of parseIdNameList(process.env.ALLOWED_USERS)) {
  const cleanNum = id.replace(/[^0-9]/g, "");
  const cleanName = name.toLowerCase();
  if (!cleanNum || !cleanName) continue;
  if (ADDRESS_BOOK[cleanName] && ADDRESS_BOOK[cleanName] !== cleanNum) {
    console.warn(`[Config] Doppelter Name "${name}" (bisher ${ADDRESS_BOOK[cleanName]}, jetzt ${cleanNum}) – letzter Eintrag gewinnt.`);
  }
  ALLOWED_USERS.push(cleanNum);
  ADDRESS_BOOK[cleanName] = cleanNum;
  NUMBER_TO_NAME[cleanNum] = name;
}

if (ADMIN_NUMBER && !ALLOWED_USERS.includes(ADMIN_NUMBER)) {
  ALLOWED_USERS.push(ADMIN_NUMBER);
}

// Persistent LID-Cache System
const LID_CACHE_FILE = path.join(AUTH_DIR, "lid_cache.json");
const autoLidMap = {};

if (fs.existsSync(LID_CACHE_FILE)) {
  try {
    const savedLids = JSON.parse(fs.readFileSync(LID_CACHE_FILE, "utf-8"));
    Object.assign(autoLidMap, savedLids);
  } catch (e) {
    console.error("[LID-Cache] Fehler beim Laden:", e.message);
  }
}

function saveLidCache() {
  try {
    const dir = path.dirname(LID_CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(autoLidMap, null, 2));
  } catch (e) {
    console.error("[LID-Cache] Fehler beim Speichern:", e.message);
  }
}

function registerLidMapping(lid, phone) {
  if (!lid || !phone) return;
  const cleanLid = lid.split("@")[0].split(":")[0];
  const cleanPhone = phone.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");

  if (cleanLid && cleanPhone && cleanPhone.length <= 13 && autoLidMap[cleanLid] !== cleanPhone) {
    autoLidMap[cleanLid] = cleanPhone;
    saveLidCache();
  }
}

const userConversations = {}; 
const msgRetryCounterCache = new NodeCache();
let sock;

/**
 * Hilfsfunktion zum Abrufen von verfügbaren Conversation Agents aus Home Assistant
 */
async function fetchAvailableAgents() {
  try {
    const res = await axios.get(haUrl("/api/states"), {
      headers: { Authorization: `Bearer ${HA_TOKEN}` }
    });
    return res.data
      .filter(e => e.entity_id.startsWith("conversation."))
      .map(e => `• \`${e.entity_id}\` (${e.attributes.friendly_name || e.entity_id})`);
  } catch (e) {
    return ["Fehler beim Abrufen der Agenten aus Home Assistant."];
  }
}

// Gruppen-Adressbuch, gleiches Format wie ALLOWED_USERS: GROUP_IDS="120363...@g.us:Familie"
const GROUP_BOOK = {};
for (const { id, name } of parseIdNameList(process.env.GROUP_IDS)) {
  if (!id.toLowerCase().endsWith("@g.us")) {
    console.warn(`[Config] Ignoriere Gruppen-Eintrag ohne @g.us-JID: "${id}"`);
    continue;
  }
  const cleanName = name.toLowerCase();
  if (GROUP_BOOK[cleanName] && GROUP_BOOK[cleanName] !== id) {
    console.warn(`[Config] Doppelter Gruppenname "${name}" – letzter Eintrag gewinnt.`);
  }
  GROUP_BOOK[cleanName] = id;
}

function resolveTargetJid(recipient) {
  const cleanRecipient = recipient.toLowerCase().trim();
  // Direkte Gruppen-JID (z.B. "120363012345678@g.us") immer durchlassen
  if (cleanRecipient.endsWith("@g.us")) return recipient.trim();
  // Gruppenname aus GROUP_IDS
  if (GROUP_BOOK[cleanRecipient]) return GROUP_BOOK[cleanRecipient];
  let targetNumber = ADDRESS_BOOK[cleanRecipient];

  if (!targetNumber) {
    const isNumeric = /^\+?\d+$/.test(cleanRecipient);
    if (isNumeric) {
      targetNumber = cleanRecipient.replace(/^\+/, "");
    } else {
      return null;
    }
  }
  return `${targetNumber}@s.whatsapp.net`;
}

async function transcribeAudio(msg) {
  if (!currentStt) {
    console.error("[HA STT] Keine STT_ENGINE aktiv.");
    return null;
  }

  const uniqueId = Date.now();
  const tmpOggPath = path.join(__dirname, `tmp_${uniqueId}.ogg`);
  const tmpWavPath = path.join(__dirname, `tmp_${uniqueId}.wav`);

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { reconnect: async () => true }
    );
    fs.writeFileSync(tmpOggPath, buffer);

    execSync(`ffmpeg -y -i "${tmpOggPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${tmpWavPath}"`, {
      stdio: "ignore",
    });

    const wavBuffer = fs.readFileSync(tmpWavPath);

    const response = await axios.post(
      haUrl(`/api/stt/${currentStt}`),
      wavBuffer,
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "audio/wav",
          "X-Speech-Content": "language=de; format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1",
        },
      }
    );

    if (response.data && response.data.result === "success") {
      return response.data.text;
    } else {
      console.error("[HA STT] Unerwartetes Antwortformat:", response.data);
      return null;
    }
  } catch (error) {
    console.error("[HA STT] Fehler bei der Transkription:", error.response?.data || error.message);
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpOggPath)) fs.unlinkSync(tmpOggPath);
      if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
    } catch (e) {}
  }
}

async function resolvePhoneNumber(msg, keys) {
  const possibleJids = [
    msg.key.remoteJidAlt,
    msg.key.participantAlt,
    msg.key.participant,
    msg.key.remoteJid,
  ].filter(Boolean);

  for (const jid of possibleJids) {
    if (jid.includes("@s.whatsapp.net")) {
      return jid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    }
  }

  const primaryJid = msg.key.remoteJid || "";
  const lidId = primaryJid.split("@")[0].split(":")[0];

  if (autoLidMap[lidId]) {
    return autoLidMap[lidId];
  }

  try {
    if (keys && typeof keys.get === "function") {
      const lidMap = await keys.get("lid-mapping", [lidId]);
      if (lidMap && lidMap[lidId]) {
        const foundNum = lidMap[lidId].replace(/[^0-9]/g, "");
        registerLidMapping(lidId, foundNum);
        return foundNum;
      }
    }
  } catch (err) {}

  // WICHTIG: kein pushName-Fallback! Der Anzeigename ist frei wählbar –
  // jeder könnte sich "Brigitte" nennen und wäre sonst als sie erkannt.
  // Ohne echte JID-Auflösung wird der Absender abgewiesen.
  return null;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    msgRetryCounterCache,
    syncFullHistory: true,
  });

  sock.ev.on("creds.update", saveCreds);

  const handleContacts = (contacts) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        registerLidMapping(contact.lid, contact.id);
      }
    }
  };

  sock.ev.on("contacts.upsert", handleContacts);
  sock.ev.on("contacts.update", handleContacts);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("--- QR CODE SCANNEN ---");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Verbindung getrennt. Reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      if (sock.user?.lid && sock.user?.id) {
        registerLidMapping(sock.user.lid, sock.user.id);
      }
      console.log("WhatsApp Bot ist erfolgreich verbunden!");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      const senderJid = msg.key.remoteJid;

      if (msg.key.fromMe) continue;

      const senderNumber = await resolvePhoneNumber(msg, state.keys);
      if (!senderNumber) {
        console.log(`[Zugriff verweigert] Absender nicht auflösbar (remoteJid:${msg.key.remoteJid || "?"} participant:${msg.key.participant || "?"} Name:${msg.pushName || "?"})`);
        continue;
      }
      const pushName = msg.pushName || NUMBER_TO_NAME[senderNumber] || "Unbekannt";
      const isAdmin = ADMIN_NUMBER && senderNumber === ADMIN_NUMBER;

      let text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        "";

      const isAudio = Boolean(msg.message?.audioMessage);
      if (!text && isAudio) {
        console.log(`[Audio empfangen] Verarbeite Sprachnachricht von ${pushName}...`);
        text = await transcribeAudio(msg);

        if (!text) {
          await sock.sendMessage(senderJid, {
            text: "Fehler: Sprachnachricht konnte nicht transkribiert werden.",
          });
          continue;
        }
      }

      if (!text) continue;

      if (!ALLOWED_USERS.includes(senderNumber)) {
        console.log(`[Zugriff verweigert] Nummer: ${senderNumber} (Name:${pushName})`);
        continue;
      }

      let cleanCmd = text.trim().toLowerCase();

      // Schnell-Zahlen aus dem Menü
      if (cleanCmd === "1") cleanCmd = "!reset";
      if (cleanCmd === "2") cleanCmd = "/status";
      if (cleanCmd === "3") cleanCmd = "/help";

      // ---------------------------------------------------------
      // STEUERBEFEHLE & ADMIN-BEFEHLE
      // ---------------------------------------------------------
      if (cleanCmd === "!reset" || cleanCmd === "/reset" || cleanCmd === "cmd_reset" || cleanCmd.includes("verlauf zurücksetzen")) {
        delete userConversations[senderNumber];
        await sock.sendMessage(senderJid, {
          text: "🔄 Dein Gesprächsverlauf wurde zurückgesetzt.",
        });
        continue;
      }

      if (cleanCmd === "/help" || cleanCmd === "!help" || cleanCmd === "hilfe" || cleanCmd.includes("hilfe")) {
        let helpMsg =
          "🤖 *Home Assistant WhatsApp-Bot*\n\n" +
          "• *Steuerung:* Schreibe oder sprich einfache Sprachbefehle.\n" +
          "• `1` oder `!reset` - Setzt den Gesprächsverlauf zurück.\n" +
          "• `2` oder `/status` - Zeigt System-Informationen an.\n" +
          "• `/ping` - Bot-Erreichbarkeit & Laufzeit.\n" +
          "• `/whoami` - Zeigt deine Benutzerinfo.";

        if (isAdmin) {
          helpMsg += 
            "\n\n👑 *Admin-Befehle:*\n" +
            "• `/setagent [id]` - Agent setzen oder alle anzeigen\n" +
            "• `/setstt [id]` - STT-Engine setzen oder anzeigen\n" +
            "• `/groups` - Gruppen mit IDs auflisten\n" +
            "• `/restart` - Startet den Bot neu";
        }

        await sock.sendMessage(senderJid, { text: helpMsg });
        continue;
      }

      if (cleanCmd === "/status") {
        const statusMsg =
          "🟢 *System Status*\n\n" +
          `• Home Assistant: ${HA_URL}\n` +
          `• STT Engine: ${currentStt || "Nicht aktiv"}\n` +

          `• Aktiver Agent: ${currentAgent || "Default"}\n` +
          `• Admin-Modus: ${isAdmin ? "Aktiv (" + senderNumber + ")" : "Nein"}\n` +
          `• Aktive Session: ${userConversations[senderNumber] ? "Ja" : "Nein"}`;
        await sock.sendMessage(senderJid, { text: statusMsg });
        continue;
      }

      if (cleanCmd === "/ping") {
        const uptimeSeconds = Math.floor(process.uptime());
        await sock.sendMessage(senderJid, { text: `🏓 Pong! Bot läuft stabil.\n⏱️ Laufzeit: ${uptimeSeconds} Sekunden` });
        continue;
      }

      if (cleanCmd === "/whoami") {
        await sock.sendMessage(senderJid, { text: `👤 *Dein Profil*\n\n• Name: ${pushName}\n• Nummer: ${senderNumber}\n• Admin: ${isAdmin ? "Ja 👑" : "Nein"}` });
        continue;
      }

      // --- ADMIN: AGENT SETZEN ODER AUFLISTEN ---
      if (cleanCmd.startsWith("/setagent")) {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        const newAgent = text.replace("/setagent", "").trim();
        if (!newAgent) {
          const agents = await fetchAvailableAgents();
          await sock.sendMessage(senderJid, {
            text: `🤖 *Verfügbare Conversation Agents in HA:*\nAktuell aktiv: \`${currentAgent || "Default"}\`\n\n` + agents.join("\n") + `\n\nNutze: \`/setagent <entity_id>\``
          });
        } else {
          currentAgent = newAgent;
          await sock.sendMessage(senderJid, { text: `✅ Konversations-Agent geändert zu:\n\`${currentAgent}\`` });
        }
        continue;
      }

      // --- ADMIN: STT ENGINE SETZEN ODER AUFLISTEN ---
      if (cleanCmd.startsWith("/setstt")) {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        const newStt = text.replace("/setstt", "").trim();
        if (!newStt) {
          await sock.sendMessage(senderJid, {
            text: `🎙️ *STT Engine*\nAktuell aktiv: \`${currentStt || "Nicht aktiv"}\`\n\nGib den Namen der Engine ein (z. B. \`/setstt stt.faster_whisper\`).`
          });
        } else {
          currentStt = newStt;
          await sock.sendMessage(senderJid, { text: `✅ STT-Engine geändert zu:\n\`${currentStt}\`` });
        }
        continue;
      }

      // --- ADMIN: GRUPPEN AUFLISTEN (IDs für GROUP_IDS / recipient) ---
      if (cleanCmd === "/groups") {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        try {
          const groups = await sock.groupFetchAllParticipating();
          const list = Object.values(groups);
          if (!list.length) {
            await sock.sendMessage(senderJid, { text: "📭 Der Bot ist in keiner Gruppe." });
          } else {
            const lines = list.map(g => `• ${g.subject}\n  \`${g.id}\``);
            await sock.sendMessage(senderJid, {
              text: `👥 *Gruppen des Bots (${list.length}):*\n\n` + lines.join("\n") + `\n\nNutze die ID als Empfänger oder trage sie in GROUP_IDS ein (z. B. \`<id>:Familie\`).`
            });
          }
        } catch (e) {
          await sock.sendMessage(senderJid, { text: `Fehler beim Abrufen der Gruppen: ${e.message}` });
        }
        continue;
      }

      if (cleanCmd === "/restart") {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        await sock.sendMessage(senderJid, { text: "🔄 Bot wird im Admin-Auftrag neu gestartet..." });
        setTimeout(() => process.exit(0), 1000);
        continue;
      }

      if (cleanCmd === "/menu") {
        const menuMsg =
          "🤖 *Hauptmenü*\n\n" +
          "Wähle eine Option (einfach Zahl senden):\n\n" +
          "1️⃣ *Verlauf zurücksetzen*\n" +
          "2️⃣ *System Status*\n" +
          "3️⃣ *Hilfe anzeigen*";
        await sock.sendMessage(senderJid, { text: menuMsg });
        continue;
      }

      console.log(`[Nachricht empfangen] Von ${pushName} (${senderNumber}): "${text}"`);

      try {
        const payload = {
          text: `[Absender: ${pushName}] ${text}`,
          language: "de",
        };

        if (currentAgent) {
          payload.agent_id = currentAgent;
        }

        if (userConversations[senderNumber]) {
          payload.conversation_id = userConversations[senderNumber];
        }

        const haResponse = await axios.post(
          haUrl("/api/conversation/process"),
          payload,
          {
            headers: {
              Authorization: `Bearer ${HA_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (haResponse.data?.conversation_id) {
          userConversations[senderNumber] = haResponse.data.conversation_id;
        }

        const responseText =
          haResponse.data?.response?.speech?.plain?.speech || "Befehl ausgeführt.";

        // Immer als Text antworten (kein TTS / keine Sprachantwort)
        await sock.sendMessage(senderJid, { text: responseText });
      } catch (error) {
        logHaError("HA Conversation", error);
        await sock.sendMessage(senderJid, {
          text: "Fehler bei der Verarbeitung in Home Assistant.",
        });
      }
    }
  });
}

// -------------------------------------------------------------
// WEBHOOK-SERVER (Home Assistant -> WhatsApp)
// -------------------------------------------------------------
const app = express();
app.use(express.json());

app.post("/send-message", async (req, res) => {
  const { message, recipient } = req.body;

  if (!message) return res.status(400).json({ error: "Keine Nachricht angegeben." });
  if (!sock) return res.status(503).json({ error: "WhatsApp Bot ist noch nicht verbunden." });
  if (!recipient) return res.status(400).json({ error: "Kein Empfänger angegeben." });

  try {
    const targetJid = resolveTargetJid(recipient);
    if (!targetJid) {
      return res.status(404).json({ error: `Empfänger "${recipient}" nicht gefunden.` });
    }

    await sock.sendMessage(targetJid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Senden via Webhook:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/send-poll", async (req, res) => {
  const { title, options, recipient } = req.body;

  if (!title || !options || !Array.isArray(options)) {
    return res.status(400).json({ error: "Titel und ein Array von 'options' sind erforderlich." });
  }
  if (!sock) return res.status(503).json({ error: "WhatsApp Bot ist noch nicht verbunden." });
  if (!recipient) return res.status(400).json({ error: "Kein Empfänger angegeben." });

  try {
    const targetJid = resolveTargetJid(recipient);
    if (!targetJid) {
      return res.status(404).json({ error: `Empfänger "${recipient}" nicht gefunden.` });
    }

    await sock.sendMessage(targetJid, {
      poll: {
        name: title,
        values: options,
        selectableCount: 1
      }
    });

    res.json({ success: true, message: "Umfrage erfolgreich gesendet." });
  } catch (err) {
    console.error("Fehler beim Senden der Umfrage via API:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`Webhook-Server läuft auf Port ${WEBHOOK_PORT}`);
});

startBot();