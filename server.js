const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Delay function (Very important to avoid rate limits)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// SSE (Live Log) Connections
let clients = [];

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);
    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

const sendLog = (message, type = 'info') => {
    console.log(`[${type.toUpperCase()}] ${message}`);
    clients.forEach(client => client.write(`data: ${JSON.stringify({ message, type })}\n\n`));
};

app.post('/api/clone', async (req, res) => {
    const { token, sourceId, targetId } = req.body;

    if (!token || !sourceId || !targetId) {
        return res.status(400).json({ error: 'Token, Source ID, and Target ID are required.' });
    }

    res.json({ success: true, message: 'Cloning process started. Follow the logs.' });

    const bot = new Client({ checkUpdate: false });

    try {
        sendLog('Logging into the account...', 'info');
        await bot.login(token);
        sendLog(`Login successful: ${bot.user.tag}`, 'success');

        const sourceGuild = bot.guilds.cache.get(sourceId);
        const targetGuild = bot.guilds.cache.get(targetId);

        if (!sourceGuild || !targetGuild) {
            throw new Error('Source or target server not found. Make sure the account is in these servers.');
        }

        sendLog('Cleaning target server...', 'warning');
        for (const channel of targetGuild.channels.cache.values()) {
            await channel.delete().catch(() => {});
            await sleep(500);
        }
        for (const role of targetGuild.roles.cache.values()) {
            if (role.name !== '@everyone' && role.editable) {
                await role.delete().catch(() => {});
                await sleep(500);
            }
        }
        sendLog('Target server cleaned.', 'success');

        const roleMap = new Map(); // Old Role ID -> New Role ID
        const categoryMap = new Map(); // Old Category ID -> New Category ID

        // 1. Copying Roles
        sendLog('Copying roles...', 'info');
        const roles = [...sourceGuild.roles.cache.values()].sort((a, b) => a.position - b.position);
        
        for (const role of roles) {
            if (role.name === '@everyone') continue;
            try {
                const newRole = await targetGuild.roles.create({
                    name: role.name,
                    color: role.color,
                    permissions: role.permissions,
                    hoist: role.hoist,
                    mentionable: role.mentionable
                });
                roleMap.set(role.id, newRole.id);
                sendLog(`Role copied: ${role.name}`, 'success');
                await sleep(1500);
            } catch (err) {
                sendLog(`Failed to copy role: ${role.name}`, 'error');
            }
        }

        // Helper function to adapt permissions for the new server
        const mapPermissions = (overwrites) => {
            return [...overwrites.values()].map(overwrite => {
                const targetRoleId = roleMap.get(overwrite.id) || targetGuild.id; // Default to @everyone if role is not found
                return {
                    id: targetRoleId,
                    allow: overwrite.allow,
                    deny: overwrite.deny
                };
            });
        };

        // 2. Copying Categories
        sendLog('Copying categories...', 'info');
        const categories = [...sourceGuild.channels.cache.values()].filter(c => c.type === 'GUILD_CATEGORY').sort((a, b) => a.position - b.position);
        
        for (const category of categories) {
            try {
                const newCategory = await targetGuild.channels.create(category.name, {
                    type: 'GUILD_CATEGORY',
                    permissionOverwrites: mapPermissions(category.permissionOverwrites.cache)
                });
                categoryMap.set(category.id, newCategory.id);
                sendLog(`Category created: ${category.name}`, 'success');
                await sleep(2000);
            } catch (err) {
                sendLog(`Category error: ${category.name}`, 'error');
            }
        }

        // 3. Copying Channels and Messages
        sendLog('Copying channels and permissions...', 'info');
        const channels = [...sourceGuild.channels.cache.values()].filter(c => c.type !== 'GUILD_CATEGORY').sort((a, b) => a.position - b.position);

        for (const channel of channels) {
            try {
                const newChannel = await targetGuild.channels.create(channel.name, {
                    type: channel.type,
                    parent: categoryMap.get(channel.parentId) || null,
                    topic: channel.topic,
                    nsfw: channel.nsfw,
                    rateLimitPerUser: channel.rateLimitPerUser,
                    permissionOverwrites: mapPermissions(channel.permissionOverwrites.cache)
                });
                sendLog(`Channel created: ${channel.name}`, 'success');
                await sleep(2500); // Discord channel creation rate limit is very strict

                // 4. Copying Messages (Last 10 messages for privacy)
                if (channel.isText() && newChannel.isText()) {
                    sendLog(`Fetching messages from ${channel.name}...`, 'info');
                    const messages = await channel.messages.fetch({ limit: 10 });
                    const msgArray = [...messages.values()].reverse(); // Sort from oldest to newest

                    for (const msg of msgArray) {
                        if (msg.content || msg.attachments.size > 0) {
                            const files = msg.attachments.map(a => a.url);
                            await newChannel.send({
                                content: `**[${msg.author.username}]**: ${msg.content}`,
                                files: files
                            }).catch(() => {});
                            await sleep(2000); // Message sending rate limit
                        }
                    }
                }
            } catch (err) {
                sendLog(`Channel/Message copy error: ${channel.name}`, 'error');
            }
        }

        sendLog('All operations completed successfully! Logging out to leave no trace...', 'warning');
        bot.destroy(); // Delete token from memory when the process is done
        sendLog('Safely logged out.', 'success');

    } catch (error) {
        sendLog(`Critical Error: ${error.message}`, 'error');
        if (bot) bot.destroy();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sprayway Server Cloner is running on port ${PORT}.`);
});
