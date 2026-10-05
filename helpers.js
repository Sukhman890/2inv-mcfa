/**
 * BOT MANAGER HELPER FUNCTIONS
 */

function trackMessage(botManager, type = "message") {
    const activeBot = botManager.getActiveBot();
    if (activeBot) {
        botManager.trackMessage(activeBot.id, type);
    }
}

async function sendDM(client, userId, payload, botManager) {
    try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return null;

        const dm = await user.send(payload);
        trackMessage(botManager, "dm");

        return dm;
    } catch (error) {
        console.error(`❌ DM to ${userId} failed:`, error.message);
        return null;
    }
}

async function sendDMBatch(client, userIds, payload, botManager, delayMs = 1500) {
    let sent = 0;
    let failed = 0;

    for (const userId of userIds) {
        const result = await sendDM(client, userId, payload, botManager);
        if (result) sent++;
        else failed++;

        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return { sent, failed };
}

function checkRateLimit(botManager, botId) {
    const stats = botManager.db.botStats[botId] || { messages: 0, dms: 0, embeds: 0 };
    const limit = 100;

    return {
        used: stats.messages,
        limit: limit,
        percentage: Math.round((stats.messages / limit) * 100),
        approaching: stats.messages > (limit * 0.8)
    };
}

function resetHourlyStats(botManager) {
    botManager.db.bots.forEach(bot => {
        if (botManager.db.botStats[bot.id]) {
            botManager.db.botStats[bot.id] = { messages: 0, dms: 0, embeds: 0 };
        }
    });
    botManager.saveManagerDB();
    console.log("🔄 Hourly stats reset");
}

function setupHourlyMaintenance(botManager, client) {
    setInterval(() => {
        resetHourlyStats(botManager);
        console.log("✅ Hourly maintenance complete");
    }, 3600000);

    console.log("⏰ Hourly maintenance scheduled");
}

module.exports = {
    trackMessage,
    sendDM,
    sendDMBatch,
    checkRateLimit,
    resetHourlyStats,
    setupHourlyMaintenance
};
