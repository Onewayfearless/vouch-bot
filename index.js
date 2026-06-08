require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionFlagsBits,
  ActivityType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ActionRowBuilder, ComponentType, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { JSONFilePreset } = require('lowdb/node');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────
let db;
async function initDB() {
  // If DATA_DIR env var is set (e.g. Railway Volume mount), use that;
  // otherwise fall back to the script's own directory.
  const dir = process.env.DATA_DIR || __dirname;
  const dbPath = path.join(dir, 'rep.json');
  console.log(`Loading database from: ${dbPath}`);
  db = await JSONFilePreset(dbPath, { guilds: {} });
}

// Debounced save: many writes in a row collapse into a single disk write.
let saveTimer = null;
let savePending = false;
function save() {
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!savePending) return;
    savePending = false;
    try { await db.write(); } catch (e) { console.error('[save error]', e); }
  }, 400);
}
// Force an immediate flush (used after important one-off changes)
async function saveNow() {
  savePending = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { await db.write(); } catch (e) { console.error('[saveNow error]', e); }
}

function defaultGuild() {
  return {
    config: {
      target_role: null, reviewer_role: null, vouch_channel: null,
      embed_color: '#5865F2', embed_footer: 'Reputation System', embed_image: null,
      auto_target_role: null, auto_queue: [], auto_rate_ms: 60000, auto_running: false,
      admins: [], server_owner: null,
      server_avatar: null, server_banner: null, server_watching: null, server_bio: null,
      lb_channel: null, lb_message_id: null, bot_status: 'online',
    },
    reviews: [], rep_totals: {}, rep_log: [], next_review_id: 1,
  };
}

function getGuild(guildId) {
  if (!db.data.guilds[guildId]) {
    db.data.guilds[guildId] = defaultGuild();
    save();
  }
  // Backfill any missing config keys for older data
  const def = defaultGuild();
  for (const k of Object.keys(def.config)) {
    if (db.data.guilds[guildId].config[k] === undefined) db.data.guilds[guildId].config[k] = def.config[k];
  }
  for (const k of ['reviews', 'rep_totals', 'rep_log', 'next_review_id']) {
    if (db.data.guilds[guildId][k] === undefined) db.data.guilds[guildId][k] = def[k];
  }
  return db.data.guilds[guildId];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function isAdmin(member, guildId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const g = getGuild(guildId);
  if (g.config.server_owner === member.id) return true;
  if (g.config.admins?.includes(member.id)) return true;
  return false;
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getRank(total) {
  if (total >= 100) return { name: 'Legend',  nextAt: null };
  if (total >= 50)  return { name: 'Elite',   nextAt: 100  };
  if (total >= 25)  return { name: 'Trusted', nextAt: 50   };
  if (total >= 10)  return { name: 'Known',   nextAt: 25   };
  return               { name: 'Starter', nextAt: 10   };
}

function progressBar(total, nextAt, length = 12) {
  if (!nextAt) return '`' + '#'.repeat(length) + '` MAX';
  const breakpoints = [0, 10, 25, 50, 100];
  const prev = [...breakpoints].reverse().find(t => t <= total && t < nextAt) ?? 0;
  const progress = total - prev;
  const needed = nextAt - prev;
  const filled = Math.min(Math.round((progress / needed) * length), length);
  return '`' + '#'.repeat(filled) + '-'.repeat(length - filled) + '` ' + progress + '/' + needed;
}

// Returns a random first-vouch number — used when someone gets their FIRST vouch
function rollFirstVouchCount() {
  return Math.floor(Math.random() * (693 - 1 + 1)) + 1;
}

function getRepTotal(guildId, userId) {
  return getGuild(guildId).rep_totals[userId] ?? 0;
}
function setRepTotal(guildId, userId, total) { getGuild(guildId).rep_totals[userId] = total; }

function getUserReviews(guildId, userId) {
  return getGuild(guildId).rep_log
    .filter(r => r.target_user_id === userId)
    .sort((a, b) => b.created_at - a.created_at);
}

function parseRate(str) {
  str = (str || '').toLowerCase().trim();
  const perSec = /s(ec)?$/.test(str) || str.includes('/s') || str.includes('sec');
  const num = parseInt((str.match(/\d+/) || [])[0]);
  if (!num || num < 1) return null;
  if (perSec) { if (num > 5) return null; return Math.floor(1000 / num); }
  if (num > 3600) return null;
  return Math.floor(60000 / num);
}

function rateLabel(ms) {
  if (ms < 1000) return `${Math.round(1000 / ms)}/sec`;
  if (ms < 60000) return `1 every ${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(60000 / ms)}/min`;
}

function applyServerWatching(guildId) {
  try {
    const g = getGuild(guildId);
    if (g.config.server_watching) client.user.setActivity(g.config.server_watching, { type: ActivityType.Watching });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Embeds
// ─────────────────────────────────────────────────────────────────────────────
function buildVouchEmbed(guildId, targetUser, reviewerUser, total, reviewText) {
  const config = getGuild(guildId).config;
  const rank = getRank(total);
  const all = getUserReviews(guildId, targetUser.id);
  const shown = all.slice(0, 20);

  // Build review lines progressively, stop when adding next would exceed 950 chars.
  // Discord limit is 1024 per field; 950 leaves safety margin so it CANNOT throw.
  let recentLines = '';
  let included = 0;
  if (shown.length) {
    for (let i = 0; i < shown.length; i++) {
      const r = shown[i];
      const ts = Math.floor(r.created_at / 1000);
      const txt = r.review_text.length > 70 ? r.review_text.slice(0, 67) + '...' : r.review_text;
      const line = `\`${String(i + 1).padStart(2, '0')}\` ${txt} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
      // Check if adding this line (plus newline) keeps us under the safe limit
      const nextLen = recentLines.length + (recentLines ? 1 : 0) + line.length;
      if (nextLen > 950) break;
      recentLines += (recentLines ? '\n' : '') + line;
      included++;
    }
    if (!recentLines) recentLines = 'reviews too long to show — use the show more button';
  } else {
    recentLines = 'no previous reviews yet';
  }
  // Final absolute safety cap (should never trigger but just in case)
  if (recentLines.length > 1020) recentLines = recentLines.slice(0, 1017) + '...';

  const embed = new EmbedBuilder()
    .setColor(config.embed_color || '#5865F2')
    .setAuthor({ name: `${targetUser.username} — Rep Update`, iconURL: targetUser.displayAvatarURL() })
    .setThumbnail(config.server_avatar || targetUser.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Total Vouches', value: `**${total}**`, inline: true },
      { name: 'Rank', value: rank.name, inline: true },
      { name: 'Progress', value: progressBar(total, rank.nextAt), inline: true },
      { name: 'Latest Review', value: `> ${reviewText}`, inline: false },
      { name: `Reviews (showing ${included}${all.length > included ? ' of ' + all.length : ''})`, value: recentLines, inline: false }
    )
    .setFooter({ text: `Vouched by ${reviewerUser.username} • ${config.embed_footer || 'Reputation System'}` })
    .setTimestamp();

  if (config.embed_image) embed.setImage(config.embed_image);
  return embed;
}

function buildShowMoreRow(guildId, targetUserId) {
  const total = getUserReviews(guildId, targetUserId).length;
  if (total <= 20) return null;
  const btn = new ButtonBuilder()
    .setCustomId(`showmore_${targetUserId}`)
    .setLabel(`Show all ${total} reviews`)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(btn);
}

function buildAllReviewsEmbeds(guildId, targetUser) {
  const config = getGuild(guildId).config;
  const all = getUserReviews(guildId, targetUser.id);
  if (!all.length) return [];

  // Discord limits: 4096 per description, 6000 total across all embeds in a message,
  // max 10 embeds per message. Each review line gets truncated to keep things sane.
  const MAX_DESC = 3900;       // safety margin under 4096
  const MAX_TOTAL = 5800;      // safety margin under 6000 total
  const MAX_EMBEDS = 5;

  const embeds = [];
  let totalChars = 0;
  let i = 0;

  while (i < all.length && embeds.length < MAX_EMBEDS) {
    let desc = '';
    const startIdx = i;
    while (i < all.length) {
      const r = all[i];
      const ts = Math.floor(r.created_at / 1000);
      const txt = r.review_text.length > 80 ? r.review_text.slice(0, 77) + '...' : r.review_text;
      const line = `\`${String(i + 1).padStart(3, '0')}\` ${txt} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
      const newLen = desc.length + (desc ? 1 : 0) + line.length;
      const titlePadding = 60; // rough title length
      if (newLen > MAX_DESC) break;
      if (totalChars + newLen + titlePadding > MAX_TOTAL) break;
      desc += (desc ? '\n' : '') + line;
      i++;
    }
    if (!desc) break;
    const title = `Reviews — ${targetUser.username} (${startIdx + 1}-${i} of ${all.length})`;
    totalChars += desc.length + title.length;
    embeds.push(new EmbedBuilder()
      .setColor(config.embed_color || '#5865F2')
      .setTitle(title)
      .setDescription(desc)
      .setFooter({ text: config.embed_footer || 'Reputation System' }));
    if (totalChars >= MAX_TOTAL - 200) break;
  }

  // If we couldn't fit them all, add a note in the last embed's footer
  if (i < all.length && embeds.length) {
    const last = embeds[embeds.length - 1];
    last.setFooter({ text: `Showing ${i} of ${all.length} — discord limits the rest` });
  }

  return embeds;
}

// ─────────────────────────────────────────────────────────────────────────────
// Milestones
// ─────────────────────────────────────────────────────────────────────────────
const MILESTONES = {
  10:   'Congrats on reaching **10 vouches** and earning the Known rank.',
  25:   'Congrats on hitting **25 vouches** and reaching Trusted.',
  50:   'Congrats on **50 vouches** — Elite rank achieved.',
  100:  'Congrats on reaching **100 vouches** and becoming a Legend.',
  250:  'Congratulations on an outstanding **250 vouches**.',
  500:  'Congratulations on reaching **500 vouches**.',
  1000: 'Congratulations on an incredible **1,000 vouches**.',
};

async function checkMilestone(guildId, guild, targetUser, total) {
  if (!MILESTONES[total]) return;
  const config = getGuild(guildId).config;
  const rank = getRank(total);
  const embed = new EmbedBuilder()
    .setColor(config.embed_color || '#FFD700')
    .setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
    .setTitle(`${total} Vouches`)
    .setDescription(`<@${targetUser.id}> ${MILESTONES[total]}`)
    .addFields(
      { name: 'Total Vouches', value: `**${total}**`, inline: true },
      { name: 'Rank', value: rank.name, inline: true }
    )
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .setFooter({ text: config.embed_footer || 'Reputation System' })
    .setTimestamp();
  if (config.embed_image) embed.setImage(config.embed_image);

  try {
    const ch = guild.channels.cache.get(config.vouch_channel);
    if (ch) await ch.send({ content: `milestone reached for <@${targetUser.id}>`, embeds: [embed] });
  } catch {}
  try { await targetUser.send({ content: `you hit a milestone in **${guild.name}**`, embeds: [embed] }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Live leaderboard
// ─────────────────────────────────────────────────────────────────────────────
async function updateLiveLeaderboard(guildId, guild) {
  try {
    const g = getGuild(guildId);
    if (!g.config.lb_channel) return;
    const channel = guild.channels.cache.get(g.config.lb_channel);
    if (!channel) return;
    const sorted = Object.entries(g.rep_totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return;
    const lines = sorted.map(([uid, total], i) =>
      `**${i + 1}.** <@${uid}> — **${total}** vouches • ${getRank(total).name}`);
    const embed = new EmbedBuilder()
      .setTitle('Live Vouch Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(g.config.embed_color || '#5865F2')
      .setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
      .setFooter({ text: `Updates every 24h • ${g.config.embed_footer || 'Reputation System'}` })
      .setTimestamp();
    if (g.config.lb_message_id) {
      try {
        const msg = await channel.messages.fetch(g.config.lb_message_id);
        await msg.edit({ embeds: [embed] });
        return;
      } catch {}
    }
    const sent = await channel.send({ embeds: [embed] });
    g.config.lb_message_id = sent.id;
    await saveNow();
  } catch (err) { console.error(`[LiveLB ${guildId}]`, err.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto vouch timer
// ─────────────────────────────────────────────────────────────────────────────
const autoTimers = {};

function stopAutoTimer(guildId) {
  if (autoTimers[guildId]) { clearInterval(autoTimers[guildId]); delete autoTimers[guildId]; }
}

function startAutoTimer(guildId, guild) {
  stopAutoTimer(guildId);
  let ms = getGuild(guildId).config.auto_rate_ms || 60000;
  if (ms < 1500) ms = 1500; // safety floor so Discord doesn't rate-limit

  autoTimers[guildId] = setInterval(async () => {
    try {
      const g = getGuild(guildId);
      if (!g.config.auto_running) { stopAutoTimer(guildId); return; }

      const channel = guild.channels.cache.get(g.config.vouch_channel);
      if (!channel) { console.warn(`[Auto ${guildId}] vouch channel missing`); return; }
      if (!g.reviews.length) { console.warn(`[Auto ${guildId}] no vouch lines`); return; }
      if (!g.config.reviewer_role) { console.warn(`[Auto ${guildId}] no reviewer role`); return; }
      if (!g.config.auto_target_role) { console.warn(`[Auto ${guildId}] no auto target role`); return; }

      // Refill queue when empty — always fetch fresh + fall back to cache
      if (!g.config.auto_queue || g.config.auto_queue.length === 0) {
        await guild.members.fetch().catch(() => {});
        const role = guild.roles.cache.get(g.config.auto_target_role);
        const ids = role?.members.filter(m => !m.user.bot).map(m => m.id) ?? [];
        if (!ids.length) { console.warn(`[Auto ${guildId}] target role empty or not cached — will retry next tick`); return; }
        g.config.auto_queue = [...ids]; // fresh copy
        save(); // persist the refilled queue so restarts dont lose it
        console.log(`[Auto ${guildId}] queue refilled with ${ids.length} members`);
      }

      const targetId = g.config.auto_queue.shift();
      save(); // persist queue progress
      if (!targetId) return; // safety check

      const targetUser = await guild.client.users.fetch(targetId).catch(() => null);
      if (!targetUser) { console.warn(`[Auto ${guildId}] could not fetch user ${targetId} skipping`); return; }

      // Refresh reviewer cache if needed
      if (!guild.roles.cache.get(g.config.reviewer_role)?.members.size) {
        await guild.members.fetch().catch(() => {});
      }
      const reviewers = guild.roles.cache.get(g.config.reviewer_role)?.members.filter(m => !m.user.bot).map(m => m.user) ?? [];
      if (!reviewers.length) { console.warn(`[Auto ${guildId}] reviewer role empty`); return; }

      const reviewerUser = pickRandom(reviewers);
      const reviewText = pickRandom(g.reviews).text;
      // First vouch ever for this user? Roll a natural-looking random count.
      // Otherwise just add +1 like normal.
      const currentTotal = getRepTotal(guildId, targetUser.id);
      const newTotal = currentTotal === 0 ? rollFirstVouchCount() : currentTotal + 1;
      setRepTotal(guildId, targetUser.id, newTotal);
      g.rep_log.push({ target_user_id: targetUser.id, reviewer_user_id: reviewerUser.id, review_text: reviewText, created_at: Date.now() });
      save();

      const row = buildShowMoreRow(guildId, targetUser.id);
      await channel.send({
        content: `<@${targetUser.id}> has received a vouch from <@${reviewerUser.id}> and got **+1** — see below`,
        embeds: [buildVouchEmbed(guildId, targetUser, reviewerUser, newTotal, reviewText)],
        components: row ? [row] : [],
      });

      // Run milestone + leaderboard in background — errors here must NOT stop the timer
      checkMilestone(guildId, guild, targetUser, newTotal).catch(e => console.error(`[Milestone ${guildId}]`, e.message));
      updateLiveLeaderboard(guildId, guild).catch(e => console.error(`[LiveLB ${guildId}]`, e.message));

    } catch (err) {
      console.error(`[AutoVouch ${guildId}]`, err);
    }
  }, ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('clientReady', async () => {
  console.log(`Online as ${client.user.tag}`);
  // status + watching from first guild that has one
  let set = false;
  for (const [, gd] of Object.entries(db.data.guilds)) {
    if (gd.config?.server_watching) { client.user.setActivity(gd.config.server_watching, { type: ActivityType.Watching }); set = true; }
    if (gd.config?.bot_status) client.user.setPresence({ status: gd.config.bot_status });
    if (set) break;
  }
  if (!set) client.user.setActivity('vouches', { type: ActivityType.Watching });

  // resume auto timers
  for (const [guildId, gd] of Object.entries(db.data.guilds)) {
    if (gd.config?.auto_running) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        // Warm up member cache before timer starts so reviewer/target roles work immediately
        guild.members.fetch().catch(() => {}).then(() => {
          startAutoTimer(guildId, guild);
          console.log(`Resumed auto timer for ${guildId}`);
        });
      }
    }
  }

  // 24h leaderboard refresh
  setInterval(async () => {
    for (const [guildId, gd] of Object.entries(db.data.guilds)) {
      if (gd.config?.lb_channel) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) await updateLiveLeaderboard(guildId, guild);
      }
    }
  }, 24 * 60 * 60 * 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Button interactions (Show More)
// ─────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('showmore_')) return;
  const targetUserId = interaction.customId.split('_')[1];
  try {
    // Defer immediately so the button doesn't time out (3 second limit otherwise)
    await interaction.deferReply({ ephemeral: true });

    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    if (!targetUser) return interaction.editReply({ content: 'cant find that user' });
    const embeds = buildAllReviewsEmbeds(interaction.guildId, targetUser);
    if (!embeds.length) return interaction.editReply({ content: 'nothin to show' });
    await interaction.editReply({ embeds });
  } catch (err) {
    console.error('[ShowMore]', err);
    try {
      if (interaction.deferred) await interaction.editReply({ content: 'somethin broke loading those reviews check railway logs' });
      else if (!interaction.replied) await interaction.reply({ content: 'somethin broke loading those reviews check railway logs', ephemeral: true });
    } catch {}
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('+')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const guild = message.guild;
  const member = message.member;
  const guildId = guild.id;

  try {
    // ── PUBLIC COMMANDS ──────────────────────────────────────────────────────
    if (command === 'admins') {
      const g = getGuild(guildId);
      const ownerLine = g.config.server_owner ? `Owner: <@${g.config.server_owner}>` : null;
      const adminLines = g.config.admins?.length ? g.config.admins.map((id, i) => `${i + 1}. <@${id}>`) : ['No admins set'];
      const embed = new EmbedBuilder()
        .setTitle(`Bot Access — ${guild.name}`)
        .setColor('#5865F2')
        .setThumbnail(guild.iconURL() || null)
        .setDescription((ownerLine ? ownerLine + '\n\n' : '') + '**Admins:**\n' + adminLines.join('\n'))
        .setFooter({ text: 'Only listed users can run admin commands' });
      return message.channel.send({ embeds: [embed] });
    }

    if (command === 'profile') {
      const targetUser = message.mentions.users.first() || message.author;
      const gm = guild.members.cache.get(targetUser.id);
      const total = getRepTotal(guildId, targetUser.id);
      const rank = getRank(total);
      const all = getUserReviews(guildId, targetUser.id);
      const shown = all.slice(0, 20);
      const config = getGuild(guildId).config;
      let lines = '';
      let linesIncluded = 0;
      if (shown.length) {
        for (let i = 0; i < shown.length; i++) {
          const r = shown[i];
          const ts = Math.floor(r.created_at / 1000);
          const txt = r.review_text.length > 70 ? r.review_text.slice(0, 67) + '...' : r.review_text;
          const line = `\`${String(i + 1).padStart(2, '0')}\` ${txt} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
          if (lines.length + (lines ? 1 : 0) + line.length > 950) break;
          lines += (lines ? '\n' : '') + line;
          linesIncluded++;
        }
        if (!lines) lines = 'reviews too long to show — use the show more button';
      } else {
        lines = 'no reviews yet';
      }
      const roles = gm?.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(' ') || 'None';
      const joined = gm?.joinedAt ? `<t:${Math.floor(gm.joinedAt / 1000)}:D>` : 'Unknown';
      const embed = new EmbedBuilder()
        .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL() })
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .setColor(config.embed_color || '#5865F2')
        .addFields(
          { name: 'Total Vouches', value: `**${total}**`, inline: true },
          { name: 'Rank', value: rank.name, inline: true },
          { name: 'Progress', value: progressBar(total, rank.nextAt), inline: true },
          { name: `Reviews (showing ${linesIncluded}${all.length > linesIncluded ? ' of ' + all.length : ''})`, value: lines, inline: false },
          { name: 'Roles', value: roles, inline: false },
          { name: 'Joined', value: joined, inline: true }
        )
        .setFooter({ text: config.embed_footer || 'Reputation System' })
        .setTimestamp();
      const row = buildShowMoreRow(guildId, targetUser.id);
      return message.channel.send({ embeds: [embed], components: row ? [row] : [] });
    }

    if (command === 'leaderboard') {
      const g = getGuild(guildId);
      const sorted = Object.entries(g.rep_totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (!sorted.length) return message.reply('no vouch data yet');
      const lines = sorted.map(([uid, total], i) => `**${i + 1}.** <@${uid}> — **${total}** vouches • ${getRank(total).name}`);
      const embed = new EmbedBuilder()
        .setTitle('Vouch Leaderboard')
        .setDescription(lines.join('\n'))
        .setColor(g.config.embed_color || '#5865F2')
        .setFooter({ text: g.config.embed_footer || 'Reputation System' })
        .setTimestamp();
      return message.channel.send({ embeds: [embed] });
    }

    if (command === 'recentreviews') {
      const targetUser = message.mentions.users.first() || message.author;
      const all = getUserReviews(guildId, targetUser.id);
      if (!all.length) return message.reply(`no reviews for <@${targetUser.id}>`);
      const shown = all.slice(0, 20);
      let lines = '';
      for (let i = 0; i < shown.length; i++) {
        const r = shown[i];
        const ts = Math.floor(r.created_at / 1000);
        const txt = r.review_text.length > 70 ? r.review_text.slice(0, 67) + '...' : r.review_text;
        const line = `\`${String(i + 1).padStart(2, '0')}\` ${txt} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
        if (lines.length + (lines ? 1 : 0) + line.length > 3500) break; // description limit is 4096
        lines += (lines ? '\n' : '') + line;
      }
      const embed = new EmbedBuilder()
        .setTitle(`Reviews — ${targetUser.username} (showing ${all.length > 20 ? '20 of ' + all.length : shown.length})`)
        .setDescription(lines || 'no reviews yet')
        .setColor(getGuild(guildId).config.embed_color || '#5865F2')
        .setTimestamp();
      const row = buildShowMoreRow(guildId, targetUser.id);
      return message.channel.send({ embeds: [embed], components: row ? [row] : [] });
    }

    if (command === 'autoconfig' || command === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('Vouch Bot — Commands')
        .setColor('#5865F2')
        .addFields(
          { name: 'Auto Vouch (Admin)', value: '`+setautotarget @role` — who gets vouched\n`+setreviewerrole @role` — who the reviewers are\n`+setvouchchannel #ch` — where it posts\n`+setrate <n>/min` or `<n>/sec`\n`+setvouchespermin <n>`\n`+startauto` / `+stopauto` / `+reset`\n`+autostatus`' },
          { name: 'Manual Vouch (Admin)', value: '`+postrep @target @reviewer`\n`+repdemo`' },
          { name: 'Vouch Lines (Admin)', value: '`+vouches add a,b,c` (bulk)\n`+vouches remove <id>`\n`+vouches list`\n`+setreviews a,b,c`' },
          { name: 'Vouch Management (Admin)', value: '`+setvouch @user <n>`\n`+addvouch @user <n>`\n`+removevouch @user <n>`' },
          { name: 'Customization (Admin)', value: '`+revamp` — dropdown (color, footer, banner, pfp, bio, watching, reset)\n`+revampreset` — wipe customization to default\n`+setwatching <text>`\n`+setbotstatus online|idle|dnd|offline`\n`+serverprofile`' },
          { name: 'Tools (Admin)', value: '`+say <message>` — bot speaks as itself\n`+massdm @role <message>` — DM a whole role (use carefully)' },
          { name: 'Leaderboard (Admin)', value: '`+setlbchannel #ch` — live board, updates 24h + on vouch' },
          { name: 'Access (Admin)', value: '`+setadmins @u1 @u2` (up to 5)\n`+setbotowner` / `+setbotowner @user`' },
          { name: 'Public', value: '`+vouches [@user]` — see vouches/profile\n`+profile [@user]` — same as above\n`+leaderboard` — top 10\n`+recentreviews [@user]` — review list\n`+admins` — who the admins are' }
        )
        .setFooter({ text: 'Reputation System' });
      return message.channel.send({ embeds: [embed] });
    }

    // ── +vouches (public version: shows profile when no add/remove/list sub) ──
    // If user types `+vouches` or `+vouches @someone`, show profile.
    // The admin sub-commands (add/remove/list) are handled below the gate.
    if (command === 'vouches') {
      const sub = args[0]?.toLowerCase();
      if (sub !== 'add' && sub !== 'remove' && sub !== 'list') {
        // Treat as profile lookup
        const targetUser = message.mentions.users.first() || message.author;
        const gm = guild.members.cache.get(targetUser.id);
        const total = getRepTotal(guildId, targetUser.id);
        const rank = getRank(total);
        const all = getUserReviews(guildId, targetUser.id);
        const shown = all.slice(0, 20);
        const config = getGuild(guildId).config;
        let lines = '';
        let linesIncluded = 0;
        if (shown.length) {
          for (let i = 0; i < shown.length; i++) {
            const r = shown[i];
            const ts = Math.floor(r.created_at / 1000);
            const txt = r.review_text.length > 70 ? r.review_text.slice(0, 67) + '...' : r.review_text;
            const line = `\`${String(i + 1).padStart(2, '0')}\` ${txt} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
            if (lines.length + (lines ? 1 : 0) + line.length > 950) break;
            lines += (lines ? '\n' : '') + line;
            linesIncluded++;
          }
          if (!lines) lines = 'reviews too long to show — use the show more button';
        } else {
          lines = 'no reviews yet';
        }
        const roles = gm?.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(' ') || 'None';
        const joined = gm?.joinedAt ? `<t:${Math.floor(gm.joinedAt / 1000)}:D>` : 'Unknown';
        const embed = new EmbedBuilder()
          .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL() })
          .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
          .setColor(config.embed_color || '#5865F2')
          .addFields(
            { name: 'Total Vouches', value: `**${total}**`, inline: true },
            { name: 'Rank', value: rank.name, inline: true },
            { name: 'Progress', value: progressBar(total, rank.nextAt), inline: true },
            { name: `Reviews (showing ${linesIncluded}${all.length > linesIncluded ? ' of ' + all.length : ''})`, value: lines, inline: false },
            { name: 'Roles', value: roles, inline: false },
            { name: 'Joined', value: joined, inline: true }
          )
          .setFooter({ text: config.embed_footer || 'Reputation System' })
          .setTimestamp();
        const row = buildShowMoreRow(guildId, targetUser.id);
        return message.channel.send({ embeds: [embed], components: row ? [row] : [] });
      }
      // Otherwise fall through to admin gate + add/remove/list handler below
    }

    // ── ADMIN GATE ───────────────────────────────────────────────────────────
    if (!isAdmin(member, guildId)) return message.reply('nah fam this ones admins only');

    // ── OWNERSHIP / ADMINS ──────────────────────────────────────────────────
    if (command === 'setbotowner' || command === 'setserverowner') {
      const g = getGuild(guildId);
      if (g.config.server_owner) {
        if (g.config.server_owner !== message.author.id) return;
        const newOwner = message.mentions.users.first();
        if (!newOwner) return message.reply('you already own it. to transfer: `+setbotowner @user`');
        g.config.server_owner = newOwner.id;
        await saveNow();
        return message.reply(`ownership of **${guild.name}** transferred to <@${newOwner.id}>`);
      }
      g.config.server_owner = message.author.id;
      await saveNow();
      return message.reply(`you're the bot owner for **${guild.name}** now. transfer with \`+setbotowner @user\``);
    }

    if (command === 'setadmins') {
      const mentions = [...message.mentions.users.values()].slice(0, 5);
      if (!mentions.length) return message.reply('use it like: `+setadmins @u1 @u2` (up to 5)');
      getGuild(guildId).config.admins = mentions.map(u => u.id);
      await saveNow();
      return message.reply(`bot admins set: ${mentions.map(u => `<@${u.id}>`).join(', ')}`);
    }

    // ── SETUP ─────────────────────────────────────────────────────────────────
    if (command === 'settargetrole') {
      const role = message.mentions.roles.first();
      if (!role) return message.reply('use it like: `+settargetrole @role`');
      getGuild(guildId).config.target_role = role.id;
      await saveNow();
      return message.reply(`manual target role set to **${role.name}**`);
    }

    if (command === 'setautotarget') {
      const role = message.mentions.roles.first();
      if (!role) return message.reply('use it like: `+setautotarget @role`');
      const g = getGuild(guildId);
      g.config.auto_target_role = role.id;
      g.config.auto_queue = [];
      await saveNow();
      return message.reply(`auto target role set to **${role.name}** — these are the ppl who get vouched`);
    }

    if (command === 'setreviewerrole') {
      const role = message.mentions.roles.first();
      if (!role) return message.reply('use it like: `+setreviewerrole @role`');
      getGuild(guildId).config.reviewer_role = role.id;
      await saveNow();
      return message.reply(`reviewer role set to **${role.name}**`);
    }

    if (command === 'setvouchchannel') {
      const channel = message.mentions.channels.first();
      if (!channel) return message.reply('use it like: `+setvouchchannel #channel`');
      getGuild(guildId).config.vouch_channel = channel.id;
      await saveNow();
      return message.reply(`vouches go to <#${channel.id}> now`);
    }

    if (command === 'setlbchannel') {
      const channel = message.mentions.channels.first();
      if (!channel) return message.reply('use it like: `+setlbchannel #channel`');
      const g = getGuild(guildId);
      g.config.lb_channel = channel.id;
      g.config.lb_message_id = null;
      await saveNow();
      await updateLiveLeaderboard(guildId, guild);
      return message.reply(`live leaderboard set in <#${channel.id}>`);
    }

    // ── RATE / AUTO ─────────────────────────────────────────────────────────
    if (command === 'setrate') {
      const ms = parseRate(args[0]);
      if (!ms) return message.reply('use it like: `+setrate 60/min` or `+setrate 3/sec` (max 5/sec)');
      getGuild(guildId).config.auto_rate_ms = ms;
      await saveNow();
      if (getGuild(guildId).config.auto_running) startAutoTimer(guildId, guild);
      return message.reply(`rate set to **${rateLabel(Math.max(ms, 1500))}**`);
    }

    if (command === 'setvouchespermin') {
      const n = parseInt(args[0]);
      if (!n || n < 1 || n > 3600) return message.reply('use it like: `+setvouchespermin 40`');
      const ms = Math.floor(60000 / n);
      getGuild(guildId).config.auto_rate_ms = ms;
      await saveNow();
      if (getGuild(guildId).config.auto_running) startAutoTimer(guildId, guild);
      return message.reply(`rate set to **${rateLabel(Math.max(ms, 1500))}**`);
    }

    if (command === 'startauto') {
      const g = getGuild(guildId);
      if (!g.config.vouch_channel) return message.reply('set a vouch channel first: `+setvouchchannel #ch`');
      if (!g.config.reviewer_role) return message.reply('set a reviewer role first: `+setreviewerrole @role`');
      if (!g.config.auto_target_role) return message.reply('set an auto target role first: `+setautotarget @role`');
      if (!g.reviews.length) return message.reply('add vouch lines first: `+vouches add <text>`');
      await guild.members.fetch().catch(() => {});
      const tCount = guild.roles.cache.get(g.config.auto_target_role)?.members.filter(m => !m.user.bot).size ?? 0;
      const rCount = guild.roles.cache.get(g.config.reviewer_role)?.members.filter(m => !m.user.bot).size ?? 0;
      if (!tCount) return message.reply('auto target role has no real members');
      if (!rCount) return message.reply('reviewer role has no real members');
      g.config.auto_running = true;
      g.config.auto_queue = [];
      await saveNow();
      startAutoTimer(guildId, guild);
      return message.reply(`auto vouch is on — **${rateLabel(Math.max(g.config.auto_rate_ms, 1500))}** runnin <@&${g.config.auto_target_role}> (${tCount} ppl) one by one`);
    }

    if (command === 'stopauto') {
      getGuild(guildId).config.auto_running = false;
      await saveNow();
      stopAutoTimer(guildId);
      return message.reply('aight stopped it');
    }

    if (command === 'reset') {
      const g = getGuild(guildId);
      g.config.auto_running = false;
      g.config.auto_queue = [];
      await saveNow();
      stopAutoTimer(guildId);
      return message.reply('reset done — auto stopped + queue cleared. vouch totals untouched. `+startauto` to restart');
    }

    if (command === 'autostatus') {
      const g = getGuild(guildId);
      const embed = new EmbedBuilder()
        .setTitle('Auto Vouch Status')
        .setColor(g.config.auto_running ? '#57F287' : '#ED4245')
        .addFields(
          { name: 'Status', value: g.config.auto_running ? 'Running' : 'Stopped', inline: true },
          { name: 'Rate', value: rateLabel(Math.max(g.config.auto_rate_ms || 60000, 1500)), inline: true },
          { name: 'Queue Left', value: `${g.config.auto_queue?.length ?? 0}`, inline: true },
          { name: 'Target Role', value: g.config.auto_target_role ? `<@&${g.config.auto_target_role}>` : 'Not set', inline: true },
          { name: 'Reviewer Role', value: g.config.reviewer_role ? `<@&${g.config.reviewer_role}>` : 'Not set', inline: true },
          { name: 'Vouch Channel', value: g.config.vouch_channel ? `<#${g.config.vouch_channel}>` : 'Not set', inline: true }
        )
        .setFooter({ text: guild.name });
      return message.channel.send({ embeds: [embed] });
    }

    // ── MANUAL VOUCH ──────────────────────────────────────────────────────────
    if (command === 'postrep' || command === 'giverep') {
      const mentions = [...message.mentions.users.values()];
      if (mentions.length < 2) return message.reply('use it like: `+postrep @target @reviewer`');
      const targetUser = mentions[0], reviewerUser = mentions[1];
      if (targetUser.bot || reviewerUser.bot) return message.reply('cant use bots for that');
      const g = getGuild(guildId);
      if (!g.config.vouch_channel) return message.reply('set a vouch channel first: `+setvouchchannel #channel`');
      if (!g.reviews.length) return message.reply('add vouch lines first: `+vouches add <text>`');
      const reviewText = pickRandom(g.reviews).text;
      const currentTotal = getRepTotal(guildId, targetUser.id);
      const newTotal = currentTotal === 0 ? rollFirstVouchCount() : currentTotal + 1;
      setRepTotal(guildId, targetUser.id, newTotal);
      g.rep_log.push({ target_user_id: targetUser.id, reviewer_user_id: reviewerUser.id, review_text: reviewText, created_at: Date.now() });
      await saveNow();
      const channel = guild.channels.cache.get(g.config.vouch_channel);
      if (!channel) return message.reply('that vouch channel ghosted me set it again');
      const row = buildShowMoreRow(guildId, targetUser.id);
      await channel.send({
        content: `<@${targetUser.id}> has received a vouch from <@${reviewerUser.id}> and got **+1** — see below`,
        embeds: [buildVouchEmbed(guildId, targetUser, reviewerUser, newTotal, reviewText)],
        components: row ? [row] : [],
      });
      await checkMilestone(guildId, guild, targetUser, newTotal);
      await updateLiveLeaderboard(guildId, guild);
      if (channel.id !== message.channel.id) message.reply(`posted in <#${channel.id}>`);
      return;
    }

    if (command === 'repdemo') {
      const embed = buildVouchEmbed(guildId, message.author, message.author, 47, 'smooth transaction, fast and trusted');
      return message.channel.send({ content: `demo vouch (no data changed)`, embeds: [embed] });
    }

    // ── VOUCH LINES ───────────────────────────────────────────────────────────
    if (command === 'vouches' || command === 'reviews' || command === 'setreviews') {
      const g = getGuild(guildId);
      let sub = args[0]?.toLowerCase();
      let raw;
      if (command === 'setreviews') {
        // everything after the command is the comma list
        sub = 'add';
        raw = message.content.slice(message.content.toLowerCase().indexOf('setreviews') + 'setreviews'.length).trim();
      } else if (sub === 'add') {
        const idx = message.content.toLowerCase().indexOf(' add');
        raw = idx !== -1 ? message.content.slice(idx + 4).trim() : '';
      }

      if (sub === 'add') {
        if (!raw) return message.reply('use it like: `+vouches add fast trade,smooth deal,trusted mm`');
        const entries = raw.split(',').map(t => t.trim()).filter(Boolean);
        if (!entries.length) return message.reply('gimme some text to add');
        if (entries.length > 5000) return message.reply('max 5000 at a time');
        const added = [];
        for (const t of entries) { const id = g.next_review_id++; g.reviews.push({ id, text: t }); added.push(id); }
        await saveNow();
        return message.reply(added.length === 1
          ? `added 1 new line (ID \`${added[0]}\`)\nyou now have **${g.reviews.length}** vouch lines total\n> ${entries[0]}`
          : `added **${added.length}** new lines (IDs \`${added[0]}\`-\`${added[added.length - 1]}\`)\nyou now have **${g.reviews.length}** vouch lines total`);
      }
      if (sub === 'remove') {
        const id = parseInt(args[1]);
        if (!id) return message.reply('use it like: `+vouches remove <id>`');
        const before = g.reviews.length;
        g.reviews = g.reviews.filter(r => r.id !== id);
        await saveNow();
        return message.reply(g.reviews.length < before ? `removed \`${id}\`` : `couldnt find \`${id}\``);
      }
      if (sub === 'list') {
        if (!g.reviews.length) return message.reply('no vouch lines saved yet');
        const embed = new EmbedBuilder()
          .setTitle(`Saved Vouch Lines (${g.reviews.length})`)
          .setDescription(g.reviews.slice(0, 40).map(r => `\`${r.id}\` ${r.text}`).join('\n'))
          .setColor('#5865F2')
          .setFooter({ text: g.reviews.length > 40 ? 'showing first 40' : `${g.reviews.length} total` });
        return message.channel.send({ embeds: [embed] });
      }
      return message.reply('use: `+vouches add a,b,c` | `+vouches remove <id>` | `+vouches list`');
    }

    // ── VOUCH MANAGEMENT ──────────────────────────────────────────────────────
    if (['setvouch', 'addvouch', 'removevouch', 'setrep', 'addrep', 'removerep'].includes(command)) {
      const targetUser = message.mentions.users.first();
      const amount = parseInt(args[1]);
      if (!targetUser || isNaN(amount)) {
        const verb = command.startsWith('set') ? 'set' : command.startsWith('add') ? 'add' : 'remove';
        return message.reply(`use it like: \`$${verb}vouch @user <amount>\``);
      }
      const old = getRepTotal(guildId, targetUser.id);
      const newTotal = command.startsWith('set') ? amount : command.startsWith('add') ? old + amount : Math.max(0, old - amount);
      setRepTotal(guildId, targetUser.id, newTotal);
      await saveNow();
      return message.reply(`<@${targetUser.id}>'s vouches: **${old}** -> **${newTotal}**`);
    }



    // ── CUSTOMIZATION ─────────────────────────────────────────────────────────
    if (command === 'setwatching') {
      const text = args.join(' ');
      if (!text) return message.reply('use it like: `+setwatching trades`');
      getGuild(guildId).config.server_watching = text;
      await saveNow();
      client.user.setActivity(text, { type: ActivityType.Watching });
      return message.reply(`watching status set to **${text}**`);
    }

    if (command === 'setbotstatus') {
      const status = args[0]?.toLowerCase();
      const map = { online: 'online', idle: 'idle', dnd: 'dnd', offline: 'invisible', invisible: 'invisible' };
      if (!status || !map[status]) return message.reply('use it like: `+setbotstatus online|idle|dnd|offline`');
      await client.user.setPresence({ status: map[status] });
      getGuild(guildId).config.bot_status = map[status];
      await saveNow();
      return message.reply(`bot status set to **${status}**`);
    }

    if (command === 'serverprofile') {
      const g = getGuild(guildId);
      const embed = new EmbedBuilder()
        .setTitle(`Server Bot Profile — ${guild.name}`)
        .setColor(g.config.embed_color || '#5865F2')
        .addFields(
          { name: 'Embed Color', value: g.config.embed_color || '#5865F2', inline: true },
          { name: 'Embed Footer', value: g.config.embed_footer || 'Reputation System', inline: true },
          { name: 'Watching', value: g.config.server_watching || 'Default', inline: true },
          { name: 'Bot Avatar', value: g.config.server_avatar ? 'Set' : 'Default', inline: true },
          { name: 'Bot Banner', value: g.config.server_banner ? 'Set' : 'Default', inline: true },
          { name: 'Live LB', value: g.config.lb_channel ? `<#${g.config.lb_channel}>` : 'Not set', inline: true }
        )
        .setFooter({ text: 'Use $revamp to change these' });
      return message.channel.send({ embeds: [embed] });
    }

    // ── $say <message> — bot posts your message as itself ──────────────────
    if (command === 'say') {
      let text = message.content.slice(message.content.toLowerCase().indexOf('say') + 3).trim();
      if (!text) return message.reply('use it like: `+say your message here`');
      text = text.replace(/@everyone/gi, 'everyone').replace(/@here/gi, 'here');
      await message.delete();
      return message.channel.send({ content: text, allowedMentions: { parse: ['users'] } });
    }

    // ── $massdm @role <message> — DM everyone in a role, no confirmation ──
    if (command === 'massdm') {
      const role = message.mentions.roles.first();
      let text = message.content.slice(message.content.toLowerCase().indexOf('massdm') + 6).trim();
      text = text.replace(/<@&\d+>/g, '').trim();
      if (!role || !text) return message.reply('use it like: `+massdm @role your message here`');

      await guild.members.fetch().catch(() => {});
      const targets = guild.roles.cache.get(role.id)?.members.filter(m => !m.user.bot).map(m => m.user) ?? [];
      if (!targets.length) return message.reply('that role got nobody real in it');

      const status = await message.reply(`sendin to **${targets.length}** member(s) of **${role.name}**...`);

      let sent = 0, failed = 0;
      for (const user of targets) {
        try { await user.send({ content: text }); sent++; }
        catch { failed++; }
        await new Promise(r => setTimeout(r, 800));
      }
      return status.edit(`done. delivered **${sent}** couldnt reach **${failed}** (dms closed)`);
    }

    // ── $revampreset — reset all customization to defaults ────────────────────
    if (command === 'revampreset') {
      const g = getGuild(guildId);
      g.config.embed_color = '#5865F2';
      g.config.embed_footer = 'Reputation System';
      g.config.embed_image = null;
      g.config.server_avatar = null;
      g.config.server_banner = null;
      g.config.server_bio = null;
      g.config.server_watching = null;
      await saveNow();
      client.user.setActivity('vouches', { type: ActivityType.Watching });
      return message.reply('reset done — color footer banner avatar bio and watching all back to default for this server');
    }

    if (command === 'revamp') {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`revamp_${guildId}_${message.author.id}`)
        .setPlaceholder('Choose a setting to change...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Embed Color').setValue('embed_color').setDescription('Hex like #FF0000'),
          new StringSelectMenuOptionBuilder().setLabel('Embed Footer').setValue('embed_footer').setDescription('Footer text'),
          new StringSelectMenuOptionBuilder().setLabel('Embed Banner').setValue('embed_image').setDescription('Image URL in vouch embeds'),
          new StringSelectMenuOptionBuilder().setLabel('Bot Avatar (this server)').setValue('server_avatar').setDescription('Image URL shown on this servers embeds'),
          new StringSelectMenuOptionBuilder().setLabel('Bot Banner (this server)').setValue('server_banner').setDescription('Image URL'),
          new StringSelectMenuOptionBuilder().setLabel('Bot Bio (this server)').setValue('server_bio').setDescription('About text'),
          new StringSelectMenuOptionBuilder().setLabel('Watching (this server)').setValue('server_watching').setDescription('What the bot is watching'),
          new StringSelectMenuOptionBuilder().setLabel('Reset to Default').setValue('reset_all').setDescription('Wipe all customization back to default'),
        );
      const row = new ActionRowBuilder().addComponents(menu);
      const prompt = await message.channel.send({ content: 'revamp — pick what to change:', components: [row] });

      const collector = prompt.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i => i.customId === `revamp_${guildId}_${message.author.id}` && i.user.id === message.author.id,
        time: 30000, max: 1,
      });

      collector.on('collect', async (interaction) => {
        const choice = interaction.values[0];

        // Reset option handled immediately, no text input needed
        if (choice === 'reset_all') {
          const g = getGuild(guildId);
          g.config.embed_color = '#5865F2';
          g.config.embed_footer = 'Reputation System';
          g.config.embed_image = null;
          g.config.server_avatar = null;
          g.config.server_banner = null;
          g.config.server_bio = null;
          g.config.server_watching = null;
          await saveNow();
          client.user.setActivity('vouches', { type: ActivityType.Watching });
          return interaction.update({ content: 'reset done — everything back to default for this server', components: [] });
        }

        const labels = {
          embed_color: 'enter a hex color like `#FF0000`',
          embed_footer: 'enter the footer text',
          embed_image: 'enter a direct image URL',
          server_avatar: 'enter a direct image URL for this servers embeds',
          server_banner: 'enter a direct image URL',
          server_bio: 'enter the bio text',
          server_watching: 'enter what the bot should be watching',
        };
        await interaction.update({ content: `${labels[choice]}\n\ntype it in chat now (30s):`, components: [] });
        const vc = message.channel.createMessageCollector({ filter: m => m.author.id === message.author.id, time: 30000, max: 1 });
        vc.on('collect', async (vm) => {
          const value = vm.content.trim();
          const g = getGuild(guildId);
          try {
            if (choice === 'embed_color') {
              if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return vm.reply('invalid hex use `#FF0000`');
              g.config.embed_color = value;
            } else if (choice === 'server_watching') {
              g.config.server_watching = value;
              client.user.setActivity(value, { type: ActivityType.Watching });
            } else {
              g.config[choice] = value;
            }
            await saveNow();
            return vm.reply(`set for **${guild.name}**`);
          } catch (e) { return vm.reply(`failed: ${e.message}`); }
        });
        vc.on('end', c => { if (!c.size) prompt.edit({ content: 'timed out', components: [] }).catch(() => {}); });
      });
      collector.on('end', c => { if (!c.size) prompt.edit({ content: 'timed out', components: [] }).catch(() => {}); });
      return;
    }

  } catch (err) {
    console.error(`[Command error] $${command} in ${guildId}:`, err);
    try { await message.reply('somethin broke runnin that try again'); } catch {}
  }
});

// ─────────────────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('Set DISCORD_TOKEN in your environment.'); process.exit(1); }
initDB().then(() => client.login(TOKEN));
