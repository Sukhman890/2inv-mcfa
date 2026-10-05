require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events,
    Partials
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const express = require("express");

// =====================================================
// EXPRESS HEALTH SERVER (24/7 Keep-Alive)
// =====================================================

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
    res.send("🤖 Multi-Bot DM & Dynamic Link Rotation Engine Active");
});

app.listen(PORT, () => {
    console.log(`🌐 Health server listening on port ${PORT}`);
});

// =====================================================
// ENVIRONMENT & MAIN TOKEN
// =====================================================

const MAIN_TOKEN =
    process.env.DISCORD_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.TOKEN ||
    process.env.CLIENT_TOKEN;

if (!MAIN_TOKEN) {
    console.error("❌ MAIN BOT TOKEN MISSING! Set DISCORD_TOKEN in Environment Variables.");
    process.exit(1);
}

// =====================================================
// DATABASE MANAGEMENT (ROBUST ABSOLUTE PATH SAVING)
// =====================================================

const DB_FILE = path.join(__dirname, "database.json");
const MANAGER_FILE = path.join(__dirname, "bot-manager.json");

const DEFAULT_DB = {
    settings: {
        autoProcess: process.env.AUTO_PROCESS !== "false",
        rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY || "1500", 10),
        requireOptIn: process.env.REQUIRE_OPT_IN === "true",
        allowRepeatDms: process.env.ALLOW_REPEAT_DMS !== "false"
    },
    protectedServers: process.env.PROTECTED_SERVERS
        ? process.env.PROTECTED_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
    customEmbed: {
        title: process.env.CUSTOM_EMBED_TITLE || "📢 Custom Bot Embed",
        description: process.env.CUSTOM_EMBED_DESCRIPTION || "Your custom embed description.",
        color: parseInt(process.env.CUSTOM_EMBED_COLOR || "3066993", 10),
        footer: process.env.CUSTOM_EMBED_FOOTER || "GANGU APP",
        thumbnail: null,
        image: null,
        author: null,
        authorIcon: null,
        footerIcon: null,
        timestamp: false,
        fields: [],
        buttons: []
    },
    dmEmbed: {
        title: process.env.DM_TITLE || "🎁 Reward Drop",
        description: process.env.DM_DESCRIPTION || "Your automatic DM broadcast message.",
        color: parseInt(process.env.DM_COLOR || "16766720", 10),
        footer: process.env.DM_FOOTER || "GANGU APP",
        thumbnail: null,
        image: null,
        author: null,
        authorIcon: null,
        footerIcon: null,
        timestamp: false,
        fields: []
    },
    buttons: [],
    optedInUsers: [],
    sentUsers: [],
    serverLog: {},
    activeEmbeds: []
};

function loadJSON(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
            return structuredClone(fallback);
        }
        const data = fs.readFileSync(filePath, "utf8");
        if (!data.trim()) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
            return structuredClone(fallback);
        }
        return JSON.parse(data);
    } catch (error) {
        console.error(`❌ Error reading ${filePath}:`, error.message);
        return structuredClone(fallback);
    }
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
        console.error(`❌ Error saving ${filePath}:`, error.message);
    }
}

function loadDB() {
    const parsed = loadJSON(DB_FILE, DEFAULT_DB);
    return {
        ...structuredClone(DEFAULT_DB),
        ...parsed,
        settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) },
        customEmbed: { ...DEFAULT_DB.customEmbed, ...(parsed.customEmbed || {}) },
        dmEmbed: { ...DEFAULT_DB.dmEmbed, ...(parsed.dmEmbed || {}) },
        buttons: Array.isArray(parsed.buttons) ? parsed.buttons : DEFAULT_DB.buttons,
        optedInUsers: Array.isArray(parsed.optedInUsers) ? parsed.optedInUsers : DEFAULT_DB.optedInUsers,
        sentUsers: Array.isArray(parsed.sentUsers) ? parsed.sentUsers : DEFAULT_DB.sentUsers,
        protectedServers: Array.isArray(parsed.protectedServers) ? parsed.protectedServers : DEFAULT_DB.protectedServers,
        serverLog: parsed.serverLog || {},
        activeEmbeds: Array.isArray(parsed.activeEmbeds) ? parsed.activeEmbeds : DEFAULT_DB.activeEmbeds
    };
}

function saveDB(db) { saveJSON(DB_FILE, db); }

function loadManagerDB() {
    return loadJSON(MANAGER_FILE, { bots: [] });
}

function saveManagerDB(data) {
    saveJSON(MANAGER_FILE, data);
}

function extractBotIdFromToken(token) {
    try {
        const parts = token.trim().split('.');
        if (parts.length < 3) return null;
        const decoded = Buffer.from(parts[0], 'base64').toString('ascii');
        return /^\d{17,20}$/.test(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

function isAdmin(message) {
    return message.member?.permissions.has(PermissionFlagsBits.Administrator);
}

function isProtectedServer(serverId, db) {
    if (!serverId) return false;
    const targetId = String(serverId).trim();
    if (Array.isArray(db.protectedServers) && db.protectedServers.some(id => String(id).trim() === targetId)) {
        return true;
    }
    if (process.env.PROTECTED_SERVERS) {
        const envProtected = process.env.PROTECTED_SERVERS.split(",").map(s => String(s).trim());
        if (envProtected.includes(targetId)) return true;
    }
    return false;
}

const activeClients = new Map();
const processingChannels = new Set(); // Global anti-double posting lock

function getMainClient() {
    for (const [id, entry] of activeClients.entries()) {
        if (entry.isMainBot && entry.client && entry.client.ws) {
            return entry.client;
        }
    }
    return null;
}

function incrementBotDmCount(botId) {
    const mgr = loadManagerDB();
    const bot = mgr.bots.find(b => b.id === botId);
    if (bot) {
        bot.dmCount = (bot.dmCount || 0) + 1;
        
        if (bot.dmCount >= 500 || bot.active === false) {
            saveManagerDB(mgr);
            markBotExpired(botId, "Reached 500 DM Limit / Marked Inactive");
            return bot.dmCount;
        }
        
        saveManagerDB(mgr);
        return bot.dmCount;
    }
    return 0;
}

function markBotExpired(botId, reason = "Flagged/Stopped Prematurely") {
    const mgr = loadManagerDB();
    const initialLength = mgr.bots.length;

    const targetBot = mgr.bots.find(b => b.id === botId);
    const dmsSent = targetBot ? (targetBot.dmCount || 0) : 0;
    console.log(`⚠️ Worker Bot (${botId}) flagged at ${dmsSent} DMs! Reason: ${reason}`);

    mgr.bots = mgr.bots.filter(b => b.id !== botId);

    if (mgr.bots.length < initialLength || targetBot) {
        saveManagerDB(mgr);
        console.log(`🗑️ Worker Bot (${botId}) REMOVED from manager database.`);

        if (activeClients.has(botId)) {
            const entry = activeClients.get(botId);
            try { entry.client.destroy(); } catch (_) {}
            activeClients.delete(botId);
        }

        const mainClient = getMainClient();
        if (mainClient) {
            refreshAllPostedEmbeds(mainClient);
        }
    }
}

// =====================================================
// WORKER BOT ROTATION & EMBED REPLACEMENT ENGINE
// =====================================================

function getBestAvailableBotInviteLink() {
    const mgr = loadManagerDB();
    if (!mgr.bots || mgr.bots.length === 0) return null;

    const validBots = mgr.bots.filter(b => b.active !== false && (b.dmCount || 0) < 500);
    if (validBots.length === 0) return null;

    const bestBot = validBots[0];
    return `https://discord.com/oauth2/authorize?client_id=${bestBot.id}&permissions=8&scope=bot`;
}

async function refreshAllPostedEmbeds(mainClient) {
    if (!mainClient) return;
    const db = loadDB();
    const bestWorkerLink = getBestAvailableBotInviteLink();
    console.log(`🔄 Rotating embeds in Discord channels... (New Link: ${bestWorkerLink || "NONE"})`);

    if (!Array.isArray(db.activeEmbeds)) db.activeEmbeds = [];
    const uniqueChannels = [...new Set(db.activeEmbeds.map(e => e.channelId))];
    const updatedEmbeds = [];

    for (const channelId of uniqueChannels) {
        if (processingChannels.has(channelId)) continue;
        processingChannels.add(channelId);

        try {
            const channel = await mainClient.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                processingChannels.delete(channelId);
                continue;
            }

            try {
                const fetchedMessages = await channel.messages.fetch({ limit: 50 });
                for (const [mId, msg] of fetchedMessages) {
                    if (msg.author.bot) {
                        await msg.delete().catch(() => {});
                    }
                }
                console.log(`  🗑️ Cleared old bot messages from channel [${channel.id}]`);
            } catch (err) {
                console.error(`  ⚠️ Could not clear messages in channel [${channelId}]:`, err.message);
            }

            if (bestWorkerLink) {
                const embed = buildEmbed(db.customEmbed);
                const addMeButton = new ButtonBuilder()
                    .setLabel("ADD ME")
                    .setURL(bestWorkerLink)
                    .setEmoji("➕")
                    .setStyle(ButtonStyle.Link);
                const components = [new ActionRowBuilder().addComponents(addMeButton)];

                const newMsg = await channel.send({ embeds: [embed], components });
                updatedEmbeds.push({ channelId: channelId, messageId: newMsg.id });
                console.log(`  ✅ Posted single fresh embed message [${newMsg.id}] in channel [${channelId}]`);
            } else {
                updatedEmbeds.push({ channelId: channelId, messageId: null });
                console.log(`  ⚠️ Old embeds cleared from [${channel.id}]. No active workers available.`);
            }
        } catch (e) {
            console.error(`  ⚠️ Error processing channel [${channelId}]:`, e.message);
        } finally {
            processingChannels.delete(channelId);
        }
    }

    db.activeEmbeds = updatedEmbeds;
    saveDB(db);
}

// =====================================================
// EMBED & BUTTON BUILDERS
// =====================================================

function buildEmbed(cfg, userId = null) {
    const embed = new EmbedBuilder();

    let title = cfg.title || "";
    let description = cfg.description || "";

    if (userId) {
        title = String(title).replace(/<@\$user\.id>/g, `<@${userId}>`);
        description = String(description).replace(/<@\$user\.id>/g, `<@${userId}>`);
    }

    if (title) embed.setTitle(String(title).slice(0, 256));
    if (description) embed.setDescription(String(description).slice(0, 4096));

    if (cfg.color !== undefined && cfg.color !== null) {
        let col;
        if (typeof cfg.color === "string") {
            const colorString = cfg.color.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(colorString)) col = parseInt(colorString.slice(1), 16);
            else if (/^[0-9]+$/.test(colorString)) col = Number(colorString);
        } else if (typeof cfg.color === "number") {
            col = cfg.color;
        }
        if (Number.isInteger(col) && col >= 0 && col <= 0xffffff) {
            try { embed.setColor(col); } catch (_) {}
        }
    }

    if (cfg.thumbnail) {
        try { if (["http:", "https:"].includes(new URL(String(cfg.thumbnail)).protocol)) embed.setThumbnail(String(cfg.thumbnail)); } catch (_) {}
    }
    if (cfg.image) {
        try { if (["http:", "https:"].includes(new URL(String(cfg.image)).protocol)) embed.setImage(String(cfg.image)); } catch (_) {}
    }
    if (cfg.footer) {
        const footerObj = { text: String(cfg.footer).slice(0, 2048) };
        if (cfg.footerIcon) {
            try { if (["http:", "https:"].includes(new URL(String(cfg.footerIcon)).protocol)) footerObj.iconURL = String(cfg.footerIcon); } catch (_) {}
        }
        try { embed.setFooter(footerObj); } catch (_) {}
    }
    if (cfg.author) {
        const authorObj = { name: String(cfg.author).slice(0, 256) };
        if (cfg.authorIcon) {
            try { if (["http:", "https:"].includes(new URL(String(cfg.authorIcon)).protocol)) authorObj.iconURL = String(cfg.authorIcon); } catch (_) {}
        }
        try { embed.setAuthor(authorObj); } catch (_) {}
    }
    if (cfg.timestamp) {
        try { embed.setTimestamp(); } catch (_) {}
    }
    if (Array.isArray(cfg.fields) && cfg.fields.length > 0) {
        const validFields = [];
        for (const f of cfg.fields.slice(0, 25)) {
            if (!f || !f.name || !f.value) continue;
            validFields.push({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline });
        }
        if (validFields.length > 0) try { embed.addFields(validFields); } catch (_) {}
    }

    return embed;
}

function buildButtonRows(buttons) {
    if (!Array.isArray(buttons) || buttons.length === 0) return [];
    const rows = [];
    let currentRow = new ActionRowBuilder();

    for (const btnConfig of buttons) {
        if (!btnConfig.url || !btnConfig.label) continue;
        try { if (!["http:", "https:"].includes(new URL(btnConfig.url).protocol)) continue; } catch (_) { continue; }

        try {
            const btn = new ButtonBuilder()
                .setLabel(String(btnConfig.label).slice(0, 80))
                .setStyle(ButtonStyle.Link)
                .setURL(String(btnConfig.url));

            if (btnConfig.emoji) try { btn.setEmoji(btnConfig.emoji); } catch (_) {}

            if (currentRow.components.length >= 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
            }
            currentRow.addComponents(btn);
            if (rows.length >= 5) break;
        } catch (_) { continue; }
    }

    if (currentRow.components.length > 0 && rows.length < 5) rows.push(currentRow);
    return rows;
}

// =====================================================
// TASK QUEUE SYSTEM (Prevents Overlaps & Rate Limits)
// =====================================================

const taskQueue = [];
let isProcessingQueue = false;

function enqueueTask(taskFunction) {
    taskQueue.push(taskFunction);
    processQueue();
}

async function processQueue() {
    if (isProcessingQueue || taskQueue.length === 0) return;
    isProcessingQueue = true;

    const currentTask = taskQueue.shift();
    try {
        await currentTask();
    } catch (err) {
        console.error("❌ Error executing task from queue:", err.message);
    } finally {
        isProcessingQueue = false;
        setImmediate(processQueue);
    }
}

// =====================================================
// MULTI-BOT SYSTEM ENGINE
// =====================================================

const clientIntents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
];

async function executeDmAndLeaveProcess(guild, client, isMainBot, triggerChannel = null) {
    if (isMainBot) {
        console.log(`🛡 [MAIN MANAGER BOT] Ignored DMall request. Main bot never sends DMs.`);
        if (triggerChannel) triggerChannel.send("⚠️ **Main Manager Bot is protected and cannot perform DMall broadcasts.**");
        return;
    }

    const db = loadDB();
    const serverId = guild.id;

    if (isProtectedServer(serverId, db)) {
        console.log(`🛡️ [PROTECTED] Server "${guild.name}" is protected. Skipping auto DM and leave.`);
        if (triggerChannel) triggerChannel.send(`🛡️ **Server \`${guild.name}\` is protected. DM process skipped.**`);
        return;
    }

    console.log(`\n=================================================`);
    console.log(`🤖 WORKER DM PROCESS STARTED — Bot: [${client.user.tag}]`);
    console.log(`🔹 Server: ${guild.name} (${serverId})`);
    console.log(`=================================================`);

    db.serverLog[serverId] = {
        serverName: guild.name,
        botUsed: client.user.tag,
        status: "⏳ Processing DMs...",
        startedAt: new Date().toLocaleString(),
        successCount: 0,
        failCount: 0,
        totalMembers: 0
    };
    saveDB(db);

    let successCount = 0;
    let failCount = 0;
    let consecutiveFails = 0; // Tracks consecutive fails for automatic link rotation

    try {
        let members;
        try {
            members = await guild.members.fetch();
        } catch (fetchErr) {
            console.error(`⚠️ Member fetch error for "${guild.name}":`, fetchErr.message);
            members = guild.members.cache;
        }

        const eligibleMembers = members.filter((m) => {
            if (m.user.bot || m.id === client.user.id) return false;
            if (!db.settings.allowRepeatDms && db.sentUsers && db.sentUsers.includes(m.id)) return false;
            if (db.settings.requireOptIn && (!db.optedInUsers || !db.optedInUsers.includes(m.id))) return false;
            return true;
        });

        const totalCount = eligibleMembers.size;
        console.log(`📋 Found ${totalCount} eligible members in "${guild.name}".`);
        if (triggerChannel) triggerChannel.send(`🚀 **Starting worker DM broadcast for ${guild.name} (${totalCount} members)...**`);

        const delayMs = db.settings.rateLimitDelay || 1500;
        const buttonRows = buildButtonRows(db.buttons);
        let current = 0;

        for (const [id, member] of eligibleMembers) {
            const mgr = loadManagerDB();
            const botData = mgr.bots.find(b => b.id === client.user.id);
            if (botData && ((botData.dmCount || 0) >= 500 || botData.active === false)) {
                console.log(`⚠️ Worker bot ${client.user.tag} capped or inactive. Purging token...`);
                markBotExpired(client.user.id, "Cap Reached / Inactive Check");
                break;
            }

            current++;
            try {
                const dmEmbed = buildEmbed(db.dmEmbed, member.id);
                const sendPayload = {
                    content: `<@${member.id}> 🎁 **Congratulations! You have won $50 Robux Giftcard / $9.99 Nitro Boost** 🎁`,
                    embeds: [dmEmbed],
                    allowedMentions: { users: [member.id] }
                };

                if (buttonRows.length > 0) sendPayload.components = buttonRows;

                await member.send(sendPayload);
                successCount++;
                consecutiveFails = 0; // Reset consecutive fail tracker on successful message delivery

                incrementBotDmCount(client.user.id);

                if (!db.sentUsers.includes(member.id)) {
                    db.sentUsers.push(member.id);
                }

                console.log(`  DL [DM ${current}/${totalCount}] ✅ Sent to @${member.user.tag}`);
            } catch (err) {
                failCount++;
                consecutiveFails++;
                console.log(`  📩 [DM ${current}/${totalCount}] ❌ Failed for @${member.user.tag} (Consecutive Fails:${consecutiveFails}/30)`);

                // If bot hits 30 consecutive failures, purge token and rotate working link
                if (consecutiveFails >= 30) {
                    console.log(`⚠️ Worker Bot reached 30 consecutive failed DMs! Purging immediately & rotating links...`);
                    markBotExpired(client.user.id, `Reached 30 consecutive failed DMs`);
                    break;
                }
            }

            if (current < totalCount) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }

        saveDB(db);

        const summaryReport = `✅ **DM Process Complete for ${guild.name}** | Sent: \`${successCount}\` | Failed: \`${failCount}\``;
        console.log(summaryReport);
        if (triggerChannel) triggerChannel.send(summaryReport);

        db.serverLog[serverId] = {
            serverName: guild.name,
            botUsed: client.user.tag,
            status: `✅ Complete (Sent: ${successCount}/${totalCount})`,
            completedAt: new Date().toLocaleString(),
            successCount,
            failCount,
            totalMembers: totalCount
        };
        saveDB(db);

    } catch (error) {
        console.error(`❌ Error executing DM process for "${guild.name}":`, error.message);
    }

    try {
        console.log(`🚪 [WORKER BOT] Leaving server: "${guild.name}" (${serverId})...`);
        await guild.leave();
        console.log(`✅ Worker bot left server: "${guild.name}"`);
        if (db.serverLog[serverId]) {
            db.serverLog[serverId].status += " | 🚪 Left Server";
            saveDB(db);
        }
    } catch (leaveErr) {
        console.error(`❌ Failed to leave server "${guild.name}":`, leaveErr.message);
    }
}

async function spawnBotInstance(token, isMainBot = false) {
    const botId = extractBotIdFromToken(token);
    if (botId && activeClients.has(botId)) return activeClients.get(botId).client;

    const client = new Client({
        intents: clientIntents,
        partials: [Partials.Channel, Partials.Message, Partials.User]
    });

    client.once(Events.ClientReady, async (c) => {
        const typeLabel = isMainBot ? "👑 MAIN MANAGER BOT" : "🤖 WORKER BOT";
        console.log(`\n=================================`);
        console.log(`✅ ${typeLabel} ONLINE`);
        console.log(`🤖 Tag: ${c.user.tag} \vert{} ID:${c.user.id}`);
        console.log(`🌐 Active Servers: ${c.guilds.cache.size}`);
        console.log(`=================================`);

        activeClients.set(c.user.id, { client, isMainBot, token });

        if (isMainBot) {
            await refreshAllPostedEmbeds(client);
        }
    });

    client.on(Events.ShardDisconnect, () => {
        if (client.user && activeClients.has(client.user.id)) {
            console.log(`⚠️ Worker Bot Disconnected: ${client.user.tag}`);
            activeClients.delete(client.user.id);
        }
    });

    client.on(Events.GuildCreate, async (guild) => {
        console.log(`\n➕ [${client.user.tag}] Joined server: ${guild.name} (${guild.id})`);

        if (isMainBot) {
            console.log(`🛡️ Main Manager Bot joined ${guild.name}. Auto-DM skipped.`);
            return;
        }

        const db = loadDB();
        if (db.settings.autoProcess) {
            enqueueTask(async () => {
                await executeDmAndLeaveProcess(guild, client, false);
            });
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (!isMainBot || message.author.bot || !message.guild) return;

        const content = message.content.trim();
        if (!content.startsWith("!")) return;

        const args = content.split(/\s+/);
        const command = args.shift().toLowerCase();

        if (command === "!addbot") {
            if (!isAdmin(message)) return message.reply("❌ Administrator permissions required.");

            const newToken = args[0];
            if (!newToken) return message.reply("❌ **Usage:** `!addbot <BOT_TOKEN>`");

            const newBotId = extractBotIdFromToken(newToken);
            if (!newBotId) return message.reply("❌ **Invalid bot token format.**");

            const mgr = loadManagerDB();
            const existingIndex = mgr.bots.findIndex(b => b.id === newBotId);
            
            if (existingIndex !== -1) {
                mgr.bots[existingIndex].token = newToken;
                mgr.bots[existingIndex].active = true;
                mgr.bots[existingIndex].dmCount = 0;
            } else {
                mgr.bots.push({ 
                    id: newBotId, 
                    token: newToken, 
                    active: true, 
                    dmCount: 0 
                });
            }
            saveManagerDB(mgr);

            await spawnBotInstance(newToken, false);
            await refreshAllPostedEmbeds(client);

            const authLink = `https://discord.com/oauth2/authorize?client_id=${newBotId}&permissions=8&scope=bot`;
            const embed = new EmbedBuilder()
                .setTitle("✅ Worker Bot Online & Linked")
                .setColor(0x2ecc71)
                .setDescription("🔄 **Token saved, old embeds deleted & new embed sent with the updated worker bot link!**")
                .addFields(
                    { name: "🆔 Bot ID", value: `\`${newBotId}\``, inline: true },
                    { name: "🔗 Invite Link", value: `[Click to Invite Worker Bot](${authLink})` }
                );

            return message.reply({ embeds: [embed] });
        }

        if (command === "!removebot" || command === "!delbot") {
            if (!isAdmin(message)) return message.reply("❌ Administrator permissions required.");

            const targetBotId = args[0];
            if (!targetBotId) return message.reply("❌ **Usage:** `!removebot <BOT_ID_OR_TOKEN>`");

            const botIdToClean = extractBotIdFromToken(targetBotId) || targetBotId;
            const mgr = loadManagerDB();
            const exists = mgr.bots.some(b => b.id === botIdToClean);

            if (!exists) {
                return message.reply(`❌ No worker bot found with ID/Token: \`${targetBotId}\``);
            }

            markBotExpired(botIdToClean, "Manual Removal by Admin");
            await refreshAllPostedEmbeds(client);

            return message.reply(`🗑️ **Successfully removed worker bot \`${botIdToClean}\` and rotated channel embeds to a working link!**`);
        }

        if (command === "!listbots" || command === "!listbot") {
            const mgr = loadManagerDB();
            if (!mgr.bots || mgr.bots.length === 0) {
                return message.reply("ℹ️ No secondary worker bots registered yet.");
            }

            let desc = "";
            mgr.bots.forEach((b, idx) => {
                const activeEntry = activeClients.get(b.id);
                let isOnline = (activeEntry && activeEntry.client?.ws?.ping >= 0) ? "🟢 ONLINE" : "🔴 OFFLINE";
                if ((b.dmCount || 0) >= 500) isOnline = "⚠️ 500 DM CAP REACHED";

                const authLink = `https://discord.com/oauth2/authorize?client_id=${b.id}&permissions=8&scope=bot`;
                desc += `**${idx + 1}. Worker Bot** (${isOnline})\n└ ID: \`${b.id}\`\n└ DMs Sent: \`${b.dmCount || 0}/500\`\n└ [Invite Auth Link](${authLink})\n\n`;
            });

            return message.reply({ embeds: [{ title: "🤖 Managed Worker Bots", description: desc, color: 0x3498db }] });
        }

        if (command === "!repeatdms" || command === "!setrepeat") {
            if (!isAdmin(message)) return message.reply("❌ Administrator permissions required.");

            const db = loadDB();
            const settingArg = args[0] ? args[0].toLowerCase() : null;

            if (settingArg === "true" || settingArg === "on" || settingArg === "allow") {
                db.settings.allowRepeatDms = true;
            } else if (settingArg === "false" || settingArg === "off" || settingArg === "disallow") {
                db.settings.allowRepeatDms = false;
            } else {
                db.settings.allowRepeatDms = !db.settings.allowRepeatDms;
            }

            saveDB(db);

            const statusText = db.settings.allowRepeatDms ? "🟢 **ENABLED** (Users can receive duplicate DMs across broadcasts)" : "🔴 **DISABLED** (Users will only receive a DM once ever)";
            return message.reply(`🔄 Repeat DM setting updated:\n${statusText}`);
        }

        if (command === "!embed") {
            const channelId = message.channel.id;
            if (processingChannels.has(channelId)) return;
            processingChannels.add(channelId);

            try {
                const db = loadDB();
                db.customEmbed = db.customEmbed || {};
                const embed = buildEmbed(db.customEmbed);

                const bestWorkerLink = getBestAvailableBotInviteLink();
                if (!bestWorkerLink) {
                    processingChannels.delete(channelId);
                    return message.reply("⚠️ **No active worker bot available under 500 DMs.** Register a worker bot using `!addbot <TOKEN>`.");
                }

                try {
                    const fetchedMessages = await message.channel.messages.fetch({ limit: 50 });
                    for (const [mId, msg] of fetchedMessages) {
                        if (msg.author.bot) {
                            await msg.delete().catch(() => {});
                        }
                    }
                } catch (err) {
                    console.error("⚠️ Error while clearing old channel messages during !embed:", err.message);
                }

                const addMeButton = new ButtonBuilder()
                    .setLabel("ADD ME")
                    .setURL(bestWorkerLink)
                    .setEmoji("➕")
                    .setStyle(ButtonStyle.Link);
                const components = [new ActionRowBuilder().addComponents(addMeButton)];

                const sentMsg = await message.channel.send({ embeds: [embed], components });

                if (!Array.isArray(db.activeEmbeds)) db.activeEmbeds = [];
                db.activeEmbeds = db.activeEmbeds.filter(e => e.channelId !== sentMsg.channel.id);
                db.activeEmbeds.push({ channelId: sentMsg.channel.id, messageId: sentMsg.id });
                saveDB(db);

                await message.delete().catch(() => {});
            } finally {
                processingChannels.delete(channelId);
            }
            return;
        }

        if (command === "!refreshembeds" || command === "!syncembeds") {
            await refreshAllPostedEmbeds(client);
            return message.reply("✅ Sync completed! Old embeds deleted and new embeds re-sent with working worker bot links.");
        }

        if (command === "!help") {
            const embed = new EmbedBuilder()
                .setTitle("👑 MAIN MANAGER BOT — System Commands")
                .setDescription("Automated multi-bot DM broadcasting & auto-replacement embed system with task queue.")
                .addFields(
                    {
                        name: "🤖 Multi-Bot & Invites",
                        value:
                            "`!addbot <token>` — Register worker bot & replace old embeds with working link\n" +
                            "`!removebot <id>` — Force-remove flagged/quarantined bots & rotate links\n" +
                            "`!listbots` — View worker bots, IDs, DM counts & statuses\n" +
                            "`!refreshembeds` — Manually delete old embeds & send fresh ones in all channels"
                    },
                    {
                        name: "⚙️ Settings & Configuration",
                        value:
                            "`!repeatdms <on/off>` — Toggle whether users can receive duplicate/repeat DMs\n" +
                            "`!embed` — Send embed with active dynamic ADD ME worker button"
                    }
                )
                .setColor(3066993);

            return message.channel.send({ embeds: [embed] });
        }
    });

    try {
        await client.login(token);
        return client;
    } catch (err) {
        console.error(`❌ Failed to log in token (${botId || "Unknown"}):`, err.message);
        if (botId && !isMainBot) markBotExpired(botId, "Login Failure");
        return null;
    }
}

// =====================================================
// SYSTEM BOOTSTRAP
// =====================================================

async function bootSystem() {
    console.log("🚀 Initializing Multi-Bot Engine...");

    if (MAIN_TOKEN) {
        await spawnBotInstance(MAIN_TOKEN, true);
    }

    const mgr = loadManagerDB();
    if (Array.isArray(mgr.bots)) {
        for (const b of mgr.bots) {
            if (b.token && b.active !== false) {
                await spawnBotInstance(b.token, false);
            }
        }
    }
}

bootSystem();
                    
