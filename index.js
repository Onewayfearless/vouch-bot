require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionFlagsBits, ActivityType, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ActionRowBuilder, ComponentType,
  ButtonBuilder, ButtonStyle
} = require('discord.js');
const { JSONFilePreset } = require('lowdb/node');
const path = require('path');

// ── Database ──────────────────────────────────────────────────────────────────
let db;

async function initDB() {
  db = await JSONFilePreset(path.join(__dirname, 'rep.json'), { guilds: {} });
}

function getGuild(guildId) {
  if (!db.data.guilds[guildId]) {
    db.data.guilds[guildId] = {
      config: {
        target_role:        null,
        reviewer_role:      null,
        vouch_channel:      null,
        embed_color:        '#5865F2',
        embed_footer:       'Reputation System',
        embed_image:        null,
        auto_target_role:   null,
        auto_queue:         [],
        auto_rate_ms:       60000, // ms between vouches
        auto_running:       false,
        admins:             [],
        server_owner:       null,
        bot_watching:       null,
        // per-server bot identity
        server_avatar:      null,
        server_banner:      null,
        server_watching:    null,
        // live leaderboard
        lb_channel:         null,
        lb_message_id:      null,
        bot_status:         'online', // online | idle | dnd | invisible
      },
      reviews:        [],
      rep_totals:     {},
      rep_log:        [],
      next_review_id: 1,
    };
    db.write();
  }
  return db.data.guilds[guildId];
}

function save() { return db.write(); }

// ── Permission check ──────────────────────────────────────────────────────────
function hasAccess(member, guildId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const g = getGuild(guildId);
  if (g.config.server_owner === member.id) return true;
  if (g.config.admins?.includes(member.id)) return true;
  return false;
}

// ── Parse rate string e.g. "60/min" "10/sec" "3" ─────────────────────────────
function parseRate(str) {
  str = str.toLowerCase().trim();
  // formats: "60/min", "10/sec", "60per_min", "10persec", "3" (default = per min)
  const perSec = /(\d+)\s*(?:\/|per\s*)?s(?:ec(?:ond)?s?)?$/.test(str);
  const num    = parseInt(str.match(/\d+/)?.[0]);
  if (!num || num < 1) return null;
  if (perSec) {
    if (num > 60) return null; // Discord rate limit safety
    return Math.floor(1000 / num); // ms between each vouch
  } else {
    if (num > 3600) return null;
    return Math.floor(60000 / num); // ms between each vouch
  }
}

function rateLabel(ms) {
  if (ms < 1000) return `${Math.round(1000 / ms)}/sec`;
  if (ms < 60000) return `every ${(ms / 1000).toFixed(1)}s`;
  const perMin = Math.round(60000 / ms);
  return perMin >= 1 ? `${perMin}/min` : `every ${Math.round(ms / 60000)}min`;
}

// ── Auto timers ───────────────────────────────────────────────────────────────
const autoTimers = {};

function stopAutoTimer(guildId) {
  if (autoTimers[guildId]) { clearInterval(autoTimers[guildId]); delete autoTimers[guildId]; }
}

function startAutoTimer(guildId, guild) {
  stopAutoTimer(guildId);
  const g  = getGuild(guildId);
  const ms = g.config.auto_rate_ms || 60000;

  autoTimers[guildId] = setInterval(async () => {
    try {
      const g = getGuild(guildId);
      if (!g.config.auto_running) { stopAutoTimer(guildId); return; }

      const channel = guild.channels.cache.get(g.config.vouch_channel);
      if (!channel || !g.reviews.length || !g.config.reviewer_role || !g.config.auto_target_role) return;

      await guild.members.fetch();

      // Build/refill queue from role
      if (!g.config.auto_queue || g.config.auto_queue.length === 0) {
        const roleMembers = guild.roles.cache.get(g.config.auto_target_role)
          ?.members.filter(m => !m.user.bot).map(m => m.id) ?? [];
        if (!roleMembers.length) return;
        g.config.auto_queue = [...roleMembers];
        await save();
      }

      const targetId   = g.config.auto_queue.shift();
      await save();
      const targetUser = await guild.client.users.fetch(targetId).catch(() => null);
      if (!targetUser) return;

      const reviewerMembers = guild.roles.cache.get(g.config.reviewer_role)
        ?.members.filter(m => !m.user.bot).toJSON();
      if (!reviewerMembers?.length) return;

      const reviewerUser = pickRandom(reviewerMembers).user;
      const reviewText   = pickRandom(g.reviews).text;
      const newTotal     = getRepTotal(guildId, targetUser.id) + 1;

      setRepTotal(guildId, targetUser.id, newTotal);
      g.rep_log.push({ target_user_id: targetUser.id, reviewer_user_id: reviewerUser.id, review_text: reviewText, created_at: Date.now() });
      await save();

      const autoRow = buildShowMoreRow(guildId, targetUser.id);
      await channel.send({
        content: `<@${targetUser.id}> has received a vouch from <@${reviewerUser.id}> and has received **+1** — look down to see more info`,
        embeds:  [buildVouchEmbed(guildId, targetUser, reviewerUser, newTotal, reviewText)],
        components: autoRow ? [autoRow] : [],
      });

      // Milestone check
      await checkMilestone(guildId, guild, targetUser, newTotal);

      // Update live leaderboard
      await updateLiveLeaderboard(guildId, guild);

    } catch (err) {
      console.error(`[AutoVouch error] ${guildId}:`, err.message);
    }
  }, ms);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getRank(total) {
  if (total >= 100) return { name: 'Legend',  nextAt: null };
  if (total >= 50)  return { name: 'Elite',   nextAt: 100  };
  if (total >= 25)  return { name: 'Trusted', nextAt: 50   };
  if (total >= 10)  return { name: 'Known',   nextAt: 25   };
  return               { name: 'Starter', nextAt: 10   };
}

function progressBar(total, nextAt, length = 12) {
  if (!nextAt) return '`' + '▰'.repeat(length) + '` **MAX**';
  const breakpoints = [0, 10, 25, 50, 100];
  const prev     = [...breakpoints].reverse().find(t => t <= total && t < nextAt) ?? 0;
  const progress = total - prev;
  const needed   = nextAt - prev;
  const filled   = Math.min(Math.round((progress / needed) * length), length);
  return `\`${'▰'.repeat(filled)}${'▱'.repeat(length - filled)}\` ${progress}/${needed}`;
}

function getRepTotal(guildId, userId) { return getGuild(guildId).rep_totals[userId] ?? 0; }

function setRepTotal(guildId, userId, total) {
  getGuild(guildId).rep_totals[userId] = total;
  save();
}

function getRecentReviews(guildId, userId, limit = 10) {
  return getGuild(guildId).rep_log
    .filter(r => r.target_user_id === userId)
    .slice(-limit).reverse();
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildVouchEmbed(guildId, targetUser, reviewerUser, total, reviewText) {
  const config = getGuild(guildId).config;
  const rank   = getRank(total);
  const allReviews = getRecentReviews(guildId, targetUser.id, 9999);
  const shown = allReviews.slice(0, 20);

  const recentLines = shown.length
    ? shown.map((r, i) => {
        const ts = Math.floor(r.created_at / 1000);
        return `\`${String(i + 1).padStart(2, '0')}\` ${r.review_text} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
      }).join('\n')
    : '_No previous reviews yet_';

  const embed = new EmbedBuilder()
    .setColor(config.embed_color || '#5865F2')
    .setAuthor({
      name:    `${targetUser.username} — Rep Update`,
      iconURL: targetUser.displayAvatarURL({ dynamic: true }),
    })
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
    .addFields(
      { name: 'Total Vouches', value: `**${total}**`,                  inline: true },
      { name: 'Rank',          value: rank.name,                       inline: true },
      { name: 'Progress',      value: progressBar(total, rank.nextAt), inline: true },
      { name: 'Latest Review', value: `> ${reviewText}`,               inline: false },
      { name: `Reviews (showing ${shown.length}${allReviews.length > 20 ? ' of ' + allReviews.length : ''})`, value: recentLines, inline: false },
    )
    .setFooter({
      text:    `Vouched by ${reviewerUser.username} • ${config.embed_footer || 'Reputation System'}`,
      iconURL: reviewerUser.displayAvatarURL({ dynamic: true }),
    })
    .setTimestamp();

  if (config.embed_image) embed.setImage(config.embed_image);
  return embed;
}

// Build a "Show More" button row if the user has more than 20 reviews
function buildShowMoreRow(guildId, targetUserId) {
  const total = getRecentReviews(guildId, targetUserId, 9999).length;
  if (total <= 20) return null;
  const btn = new ButtonBuilder()
    .setCustomId(`showmore_${targetUserId}`)
    .setLabel(`Show All ${total} Reviews`)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(btn);
}

// Build paginated full-review embeds (for the Show More button)
function buildAllReviewsEmbeds(guildId, targetUser) {
  const config = getGuild(guildId).config;
  const all = getRecentReviews(guildId, targetUser.id, 9999);
  const perPage = 25;
  const embeds = [];
  for (let p = 0; p < all.length; p += perPage) {
    const slice = all.slice(p, p + perPage);
    const lines = slice.map((r, i) => {
      const ts = Math.floor(r.created_at / 1000);
      return `\`${String(p + i + 1).padStart(3, '0')}\` ${r.review_text} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
    }).join('\n');
    embeds.push(new EmbedBuilder()
      .setColor(config.embed_color || '#5865F2')
      .setTitle(`All Reviews — ${targetUser.username} (${p + 1}-${Math.min(p + perPage, all.length)} of ${all.length})`)
      .setDescription(lines)
      .setFooter({ text: config.embed_footer || 'Reputation System' }));
  }
  return embeds.slice(0, 10); // Discord allows max 10 embeds per message
}

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ── Milestone thresholds ─────────────────────────────────────────────────────
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

async function checkMilestone(guildId, guild, targetUser, total) {
  if (!MILESTONES.includes(total)) return;
  const g       = getGuild(guildId);
  const config  = g.config;
  const rank    = getRank(total);

  const milestoneMessages = {
    10:   { title: '10 Vouches',   desc: `Congrats on reaching **10 vouches** and earning the Known rank.` },
    25:   { title: '25 Vouches',   desc: `Congrats on hitting **25 vouches** and reaching Trusted.` },
    50:   { title: '50 Vouches',   desc: `Congrats on **50 vouches** — Elite rank achieved.` },
    100:  { title: '100 Vouches',  desc: `Congrats on reaching **100 vouches** and becoming a Legend.` },
    250:  { title: '250 Vouches',  desc: `Congratulations on an outstanding **250 vouches**.` },
    500:  { title: '500 Vouches',  desc: `Congratulations on reaching **500 vouches**.` },
    1000: { title: '1000 Vouches', desc: `Congratulations on an incredible **1,000 vouches**.` },
  };

  const m = milestoneMessages[total];
  const milestoneColors = { 10: '#3498DB', 25: '#2ECC71', 50: '#9B59B6', 100: '#FFD700', 250: '#E74C3C', 500: '#FF6B35', 1000: '#FF0080' };

  const embed = new EmbedBuilder()
    .setColor(milestoneColors[total] || '#FFD700')
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
    .setTitle(m.title)
    .setDescription(`<@${targetUser.id}> ${m.desc}`)
    .addFields(
      { name: 'Total Vouches', value: `**${total}**`, inline: true },
      { name: 'Current Rank',  value: rank.name,       inline: true },
      { name: '​',           value: '​',         inline: true },
    )
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
    .setImage(config.embed_image || null)
    .setFooter({ text: config.embed_footer || 'Reputation System' })
    .setTimestamp();

  // Post in vouch channel
  try {
    const ch = guild.channels.cache.get(config.vouch_channel);
    if (ch) await ch.send({ content: `Milestone reached for <@${targetUser.id}>!`, embeds: [embed] });
  } catch {}

  // DM the user
  try { await targetUser.send({ content: `You just hit a milestone in **${guild.name}**!`, embeds: [embed] }); } catch {}
}

// ── Live leaderboard updater ──────────────────────────────────────────────────
async function updateLiveLeaderboard(guildId, guild) {
  try {
    const g = getGuild(guildId);
    if (!g.config.lb_channel) return;
    const channel = guild.channels.cache.get(g.config.lb_channel);
    if (!channel) return;

    const sorted = Object.entries(g.rep_totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return;

    const medals = ['1st', '2nd', '3rd'];
    const lines  = sorted.map(([uid, total], i) =>
      `**${medals[i] ?? (i + 1) + '.'}** <@${uid}> — **${total}** vouches  •  ${getRank(total).name}`
    );

    const embed = new EmbedBuilder()
      .setTitle('Live Vouch Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(g.config.embed_color || '#5865F2')
      .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
      .setFooter({ text: `Updates every 24h  •  ${g.config.embed_footer || 'Reputation System'}` })
      .setTimestamp();

    if (g.config.lb_message_id) {
      try {
        const msg = await channel.messages.fetch(g.config.lb_message_id);
        await msg.edit({ embeds: [embed] });
        return;
      } catch { /* message deleted, post new one */ }
    }

    const sent = await channel.send({ embeds: [embed] });
    g.config.lb_message_id = sent.id;
    await save();
  } catch (err) {
    console.error(`[LiveLB error] ${guildId}:`, err.message);
  }
}

client.once('clientReady', async () => {
  console.log(` Online as ${client.user.tag}`);

  // Set default status
  let statusSet = false;
  for (const [, guildData] of Object.entries(db.data.guilds)) {
    if (guildData.config?.bot_watching || guildData.config?.server_watching) {
      client.user.setActivity(guildData.config.server_watching || guildData.config.bot_watching, { type: ActivityType.Watching });
      statusSet = true; break;
    }
  }
  if (!statusSet) client.user.setActivity('vouches', { type: ActivityType.Watching });

  // Restore saved bot status
  for (const [, guildData] of Object.entries(db.data.guilds)) {
    if (guildData.config?.bot_status) {
      client.user.setPresence({ status: guildData.config.bot_status });
      break;
    }
  }

  // Resume auto vouch timers
  for (const [guildId, guildData] of Object.entries(db.data.guilds)) {
    if (guildData.config?.auto_running) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) { startAutoTimer(guildId, guild); console.log(`▶ Resumed auto timer for ${guildId}`); }
    }
  }

  // Live leaderboard — update every 24 hours
  setInterval(async () => {
    for (const [guildId, guildData] of Object.entries(db.data.guilds)) {
      if (guildData.config?.lb_channel) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) await updateLiveLeaderboard(guildId, guild);
      }
    }
  }, 24 * 60 * 60 * 1000);

});

// ── Commands ──────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('$')) return;

  const args    = message.content.slice(1).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const guild   = message.guild;
  const member  = message.member;
  const guildId = guild.id;

  // ── PUBLIC COMMANDS (no access check) ─────────────────────────────────────

  // $admins — anyone can use
  if (command === 'admins') {
    const g = getGuild(guildId);
    const ownerLine  = g.config.server_owner ? ` <@${g.config.server_owner}> — Server Owner` : null;
    const adminLines = g.config.admins?.length
      ? g.config.admins.map((id, i) => `\`${i + 1}.\` <@${id}>`)
      : ['_No admins set_'];

    const embed = new EmbedBuilder()
      .setTitle('Bot Access — ' + guild.name)
      .setColor('#5865F2')
      .setThumbnail(guild.iconURL({ dynamic: true }) || null)
      .setDescription((ownerLine ? ownerLine + '\n\n' : '') + '**Bot Admins:**\n' + adminLines.join('\n'))
      .setFooter({ text: 'Only listed users can run admin commands' });
    return message.channel.send({ embeds: [embed] });
  }

  // $profile — anyone can use
  if (command === 'profile') {
    const targetUser  = message.mentions.users.first() || message.author;
    const guildMember = guild.members.cache.get(targetUser.id);
    const total       = getRepTotal(guildId, targetUser.id);
    const rank        = getRank(total);
    const recent      = getRecentReviews(guildId, targetUser.id, 5);
    const config      = getGuild(guildId).config;

    const recentLines = recent.length
      ? recent.map((r, i) => {
          const ts = Math.floor(r.created_at / 1000);
          return `\`${i + 1}.\` ${r.review_text} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
        }).join('\n')
      : '_No reviews yet_';

    const roles  = guildMember?.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(' ') || '_None_';
    const joined = guildMember?.joinedAt ? `<t:${Math.floor(guildMember.joinedAt / 1000)}:D>` : '_Unknown_';

    const embed = new EmbedBuilder()
      .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL({ dynamic: true }) })
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
      .setColor(config.embed_color || '#5865F2')
      .addFields(
        { name: 'Total Vouches',  value: `**${total}**`,                  inline: true  },
        { name: 'Rank',           value: rank.name,                       inline: true  },
        { name: '\u200b',            value: '\u200b',                        inline: true  },
        { name: 'Progress',       value: progressBar(total, rank.nextAt),  inline: false },
        { name: 'Recent Reviews', value: recentLines,                     inline: false },
        { name: 'Roles',          value: roles,                           inline: false },
        { name: 'Joined',         value: joined,                          inline: true  },
      )
      .setFooter({ text: config.embed_footer || 'Reputation System' })
      .setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  // $leaderboard — anyone can use
  if (command === 'leaderboard') {
    const g      = getGuild(guildId);
    const sorted = Object.entries(g.rep_totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return message.reply('No vouch data yet.');
    const medals = ['1st', '2nd', '3rd'];
    const lines  = sorted.map(([userId, total], i) =>
      `**${medals[i] ?? (i + 1) + '.'}** <@${userId}> — **${total}** vouches  •  ${getRank(total).name}`
    );
    const embed = new EmbedBuilder()
      .setTitle('Vouch Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(getGuild(guildId).config.embed_color || '#5865F2')
      .setFooter({ text: getGuild(guildId).config.embed_footer || 'Reputation System' })
      .setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  // $recentreviews — anyone can use (shows 20, button reveals all)
  if (command === 'recentreviews') {
    const targetUser = message.mentions.users.first() || message.author;
    const all        = getRecentReviews(guildId, targetUser.id, 9999);
    if (!all.length) return message.reply(`No reviews found for <@${targetUser.id}>.`);
    const shown = all.slice(0, 20);
    const lines = shown.map((r, i) => {
      const ts = Math.floor(r.created_at / 1000);
      return `\`${String(i + 1).padStart(2, '0')}\` ${r.review_text} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`Reviews — ${targetUser.username} (showing ${shown.length}${all.length > 20 ? ' of ' + all.length : ''})`)
      .setDescription(lines.join('\n'))
      .setColor(getGuild(guildId).config.embed_color || '#5865F2')
      .setFooter({ text: getGuild(guildId).config.embed_footer || 'Reputation System' })
      .setTimestamp();
    const row = buildShowMoreRow(guildId, targetUser.id);
    return message.channel.send({ embeds: [embed], components: row ? [row] : [] });
  }

  // $autoconfig — anyone can use
  if (command === 'autoconfig') {
    const embed = new EmbedBuilder()
      .setTitle('Rep Bot — All Commands')
      .setColor('#5865F2')
      .addFields(
        { name: 'Auto Vouch (Admin)', value: '`$setautotarget @role` — Role to vouch one by one\n`$setreviewerrole @role` — Reviewer pool\n`$setrate <n>/min` or `<n>/sec` — Speed\n`$setvouchespermin <n>` — e.g. `$setvouchespermin 70`\n`$startauto` / `$stopauto` — Start or stop\n`$autostatus` — Current status' },
        { name: 'Manual Vouch (Admin)',  value: '`$postrep @target @reviewer` — Post a manual vouch\n`$repdemo` — Preview embed' },
        { name: 'Setup (Admin)',         value: '`$settargetrole @role`\n`$setvouchchannel #ch`\n`$repstatus`' },
        { name: 'Vouch Lines (Admin)', value: '`$vouches add text1,text2,text3` — Comma-separated bulk add\n`$vouches remove <id>`\n`$vouches list`' },
        { name: 'Vouch Management (Admin)', value: '`$setvouch @user <n>` — Set a user\'s vouches\n`$addvouch @user <n>` — Add vouches\n`$removevouch @user <n>` — Remove vouches\n`$setvouches @role 150-483` — Bulk random assign to a whole role + fake history' },
        { name: 'Customization (Admin)', value: '`$revamp` — Dropdown (embed color, footer, banner, bot pfp, bio, watching)\n`$setwatching <text>` — Quick watching status\n`$serverprofile` — View this server\'s bot settings' },
        { name: 'Live Leaderboard (Admin)', value: '`$setlbchannel #channel` — Post a live leaderboard that updates every 24h' },
        { name: 'Access Control (Admin)', value: '`$setadmins @u1 @u2...` — Set up to 5 bot admins\n`$setbotowner` — Claim bot ownership for this server (first run)\n`$setbotowner @user` — Transfer ownership to someone else' },
        { name: 'Public (Anyone)', value: '`$profile [@user]`\n`$leaderboard`\n`$recentreviews [@user]`\n`$admins` — See who the admins are\n`$autoconfig` — This menu' },
        { name: 'Bot Status (Admin)', value: '`$setbotstatus <online|idle|dnd|offline>` — Change bot presence' },
      )
      .setFooter({ text: 'Reputation System' });
    return message.channel.send({ embeds: [embed] });
  }

  // ── ALL COMMANDS BELOW ARE ADMIN ONLY ─────────────────────────────────────
  if (!hasAccess(member, guildId)) return message.reply('nah fam, this ones admins only. nice try tho');

  // ── $setbotstatus ─────────────────────────────────────────────────────────
  if (command === 'setbotstatus') {
    const status = args[0]?.toLowerCase();
    const valid  = { online: 'online', idle: 'idle', dnd: 'dnd', offline: 'invisible', invisible: 'invisible' };
    if (!status || !valid[status]) {
      return message.reply('Usage: `$setbotstatus <online|idle|dnd|offline>`');
    }
    const presence = valid[status];
    await client.user.setPresence({ status: presence });
    getGuild(guildId).config.bot_status = presence;
    await save();
    const labels = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Offline/Invisible' };
    return message.reply(`bot's set to **${labels[presence]}**`);
  }

  // ── $setserverowner / $setbotowner ───────────────────────────────────────────
  if (command === 'setserverowner' || command === 'setbotowner') {
    const g = getGuild(guildId);
    if (g.config.server_owner) {
      // Already set — only current owner can reassign
      if (g.config.server_owner !== message.author.id) return;
      const newOwner = message.mentions.users.first();
      if (!newOwner) return message.reply('You are already the owner. Mention a user to transfer: `$setbotowner @user`');
      g.config.server_owner = newOwner.id;
      await save();
      return message.reply(`Bot ownership for **${guild.name}** transferred to <@${newOwner.id}>.`);
    }
    g.config.server_owner = message.author.id;
    await save();
    return message.reply(`You are now the **Bot Owner** for **${guild.name}**. Only you can transfer this role.
Use \`$setbotowner @user\` to transfer ownership.`);
  }

  // ── $setadmins ─────────────────────────────────────────────────────────────
  if (command === 'setadmins') {
    const mentions = [...message.mentions.users.values()].slice(0, 5);
    if (!mentions.length) return message.reply('Usage: `$setadmins @user1 @user2 ...` (up to 5)');
    getGuild(guildId).config.admins = mentions.map(u => u.id);
    await save();
    return message.reply(`Bot admins set: ${mentions.map(u => `<@${u.id}>`).join(', ')}`);
  }

  // ── $postrep @target @reviewer ─────────────────────────────────────────────
  if (command === 'postrep' || command === 'giverep') {
    const mentions = [...message.mentions.users.values()];
    if (mentions.length < 2) return message.reply('Usage: `$postrep @target @reviewer`');
    const targetUser   = mentions[0];
    const reviewerUser = mentions[1];
    if (targetUser.bot || reviewerUser.bot) return message.reply('cant vouch a bot bro what');

    const g = getGuild(guildId);
    if (!g.config.vouch_channel) return message.reply('set a vouch channel first dummy — `$setvouchchannel #channel`');
    if (!g.reviews.length) return message.reply('no vouch lines saved bro, add some first');

    if (g.config.target_role || g.config.reviewer_role) await guild.members.fetch();
    if (g.config.target_role) {
      const t = guild.members.cache.get(targetUser.id);
      if (!t?.roles.cache.has(g.config.target_role))
        return message.reply(`<@${targetUser.id}> doesn't have the target role.`);
    }
    if (g.config.reviewer_role) {
      const r = guild.members.cache.get(reviewerUser.id);
      if (!r?.roles.cache.has(g.config.reviewer_role))
        return message.reply(`<@${reviewerUser.id}> doesn't have the reviewer role.`);
    }

    const reviewText = pickRandom(g.reviews).text;
    const newTotal   = getRepTotal(guildId, targetUser.id) + 1;
    setRepTotal(guildId, targetUser.id, newTotal);
    g.rep_log.push({ target_user_id: targetUser.id, reviewer_user_id: reviewerUser.id, review_text: reviewText, created_at: Date.now() });
    await save();

    const channel = guild.channels.cache.get(g.config.vouch_channel);
    if (!channel) return message.reply('that vouch channel ghosted me, set it again');
    const manualRow = buildShowMoreRow(guildId, targetUser.id);
    await channel.send({
      content: `<@${targetUser.id}> has received a vouch from <@${reviewerUser.id}> and has received **+1** — look down to see more info`,
      embeds:  [buildVouchEmbed(guildId, targetUser, reviewerUser, newTotal, reviewText)],
      components: manualRow ? [manualRow] : [],
    });
    await checkMilestone(guildId, guild, targetUser, newTotal);
    await updateLiveLeaderboard(guildId, guild);
    if (channel.id !== message.channel.id) message.reply(`Vouch posted in <#${channel.id}>.`);
    return;
  }

  // ── $setautotarget @role ───────────────────────────────────────────────────
  if (command === 'setautotarget') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply('Usage: `$setautotarget @role`');
    const g = getGuild(guildId);
    g.config.auto_target_role = role.id;
    g.config.auto_queue       = [];
    await save();
    return message.reply(`aight, **${role.name}** is the target now, runs through em one by one`);
  }

  // ── $setreviewerrole ───────────────────────────────────────────────────────
  if (command === 'setreviewerrole') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply('Usage: `$setreviewerrole @role`');
    getGuild(guildId).config.reviewer_role = role.id;
    await save();
    return message.reply(`reviewer role set to **${role.name}**`);
  }

  // ── $setrate ───────────────────────────────────────────────────────────────
  if (command === 'setrate') {
    const input = args[0];
    if (!input) return message.reply('Usage: `$setrate <n>/min` or `$setrate <n>/sec`\nExamples: `$setrate 60/min` `$setrate 10/sec` `$setrate 3`');
    const ms = parseRate(input);
    if (!ms) return message.reply('Invalid rate. Examples: `$setrate 60/min` `$setrate 5/sec` (max 60/sec)');
    getGuild(guildId).config.auto_rate_ms = ms;
    await save();
    // Restart timer if running
    const g = getGuild(guildId);
    if (g.config.auto_running) startAutoTimer(guildId, guild);
    return message.reply(`aight, rate's **${rateLabel(ms)}** now`);
  }

  // ── $setvouchespermin <n> ────────────────────────────────────────────────────
  if (command === 'setvouchespermin') {
    const n = parseInt(args[0]);
    if (!n || n < 1 || n > 3600) return message.reply('Usage: `$setvouchespermin <number>` e.g. `$setvouchespermin 70`');
    const ms = Math.floor(60000 / n);
    getGuild(guildId).config.auto_rate_ms = ms;
    await save();
    const g = getGuild(guildId);
    if (g.config.auto_running) startAutoTimer(guildId, guild);
    return message.reply(`aight, **${n} a min** now (one every ~${(ms/1000).toFixed(1)}s)`);
  }

  // ── $startauto ─────────────────────────────────────────────────────────────
  if (command === 'startauto') {
    const g = getGuild(guildId);
    if (!g.config.vouch_channel)    return message.reply('Set vouch channel first: `$setvouchchannel #ch`');
    if (!g.config.reviewer_role)    return message.reply('Set reviewer role first: `$setreviewerrole @role`');
    if (!g.config.auto_target_role) return message.reply('Set auto target role first: `$setautotarget @role`');
    if (!g.reviews.length)          return message.reply('Add vouch lines first: `$vouches add <text>`');
    g.config.auto_running = true;
    await save();
    startAutoTimer(guildId, guild);
    return message.reply(`auto vouch is on — **${rateLabel(g.config.auto_rate_ms)}**, runnin <@&${g.config.auto_target_role}> one by one`);
  }

  // ── $stopauto ──────────────────────────────────────────────────────────────
  if (command === 'stopauto') {
    getGuild(guildId).config.auto_running = false;
    await save();
    stopAutoTimer(guildId);
    return message.reply('aight, stopped it');
  }

  // ── $autostatus ────────────────────────────────────────────────────────────
  if (command === 'autostatus') {
    const g     = getGuild(guildId);
    const embed = new EmbedBuilder()
      .setTitle('Auto Vouch Status')
      .setColor(g.config.auto_running ? '#57F287' : '#ED4245')
      .addFields(
        { name: 'Status',        value: g.config.auto_running ? 'Running' : 'Stopped',                         inline: true  },
        { name: 'Rate',          value: rateLabel(g.config.auto_rate_ms || 60000),                                    inline: true  },
        { name: 'Queue Left',    value: `${g.config.auto_queue?.length ?? 0} members`,                               inline: true  },
        { name: 'Target Role',   value: g.config.auto_target_role ? `<@&${g.config.auto_target_role}>` : '_Not set_', inline: true  },
        { name: 'Reviewer Role', value: g.config.reviewer_role    ? `<@&${g.config.reviewer_role}>`  : '_Not set_', inline: true  },
        { name: 'Vouch Channel', value: g.config.vouch_channel    ? `<#${g.config.vouch_channel}>`  : '_Not set_', inline: true  },
      )
      .setFooter({ text: guild.name });
    return message.channel.send({ embeds: [embed] });
  }

  // ── $repdemo ───────────────────────────────────────────────────────────────
  if (command === 'repdemo') {
    getGuild(guildId);
    const embed = buildVouchEmbed(guildId, message.author, message.author, 47, 'smooth transaction, fast and trusted — no issues at all');
    return message.channel.send({
      content: `<@${message.author.id}> has received a vouch from <@${message.author.id}> and has received **+1** — look down to see more info _(demo)_`,
      embeds: [embed],
    });
  }

  // ── $settargetrole ─────────────────────────────────────────────────────────
  if (command === 'settargetrole') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply('Usage: `$settargetrole @role`');
    getGuild(guildId).config.target_role = role.id;
    await save();
    return message.reply(`target role set to **${role.name}**`);
  }

  // ── $setvouchchannel ───────────────────────────────────────────────────────
  if (command === 'setvouchchannel') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('Usage: `$setvouchchannel #channel`');
    getGuild(guildId).config.vouch_channel = channel.id;
    await save();
    return message.reply(`vouches go to <#${channel.id}> now`);
  }

  // ── $repstatus ─────────────────────────────────────────────────────────────
  if (command === 'repstatus') {
    const g = getGuild(guildId);
    const embed = new EmbedBuilder()
      .setTitle('Rep System Config')
      .setColor('#5865F2')
      .addFields(
        { name: 'Target Role',     value: g.config.target_role   ? `<@&${g.config.target_role}>` : '_Not set_', inline: true },
        { name: 'Reviewer Role',   value: g.config.reviewer_role ? `<@&${g.config.reviewer_role}>` : '_Not set_', inline: true },
        { name: 'Vouch Channel',   value: g.config.vouch_channel ? `<#${g.config.vouch_channel}>` : '_Not set_',  inline: true },
        { name: 'Vouch Lines', value: `${g.reviews.length}`,                                                      inline: true },
        { name: 'Bot Admins',      value: g.config.admins?.length ? g.config.admins.map(id => `<@${id}>`).join(', ') : '_None_', inline: false },
      )
      .setFooter({ text: guild.name });
    return message.channel.send({ embeds: [embed] });
  }

  // ── $reviews ───────────────────────────────────────────────────────────────
  // ── $setreviews <text,text,text> — quick alias to bulk-add vouch lines ──────
  if (command === 'setreviews') {
    const g   = getGuild(guildId);
    const idx = message.content.toLowerCase().indexOf('setreviews');
    const raw = idx !== -1 ? message.content.slice(idx + 'setreviews'.length).trim() : '';
    if (!raw) return message.reply('use it like: `$setreviews fast trade,smooth deal,trusted mm,easy n clean`');
    const entries = raw.split(',').map(t => t.trim()).filter(Boolean);
    if (entries.length > 5000) return message.reply('whoa, max 5000 at a time');
    const added = [];
    for (const t of entries) { const id = g.next_review_id++; g.reviews.push({ id, text: t }); added.push(id); }
    await save();
    return message.reply(added.length === 1
      ? `added 1 line (ID \`${added[0]}\`)\n> ${entries[0]}`
      : `added **${added.length}** lines (IDs \`${added[0]}\`-\`${added[added.length - 1]}\`)`);
  }

  if (command === 'vouches' || command === 'reviews') {
    const sub = args[0]?.toLowerCase();
    const g   = getGuild(guildId);

    if (sub === 'add') {
      // Everything after "add" is the raw input (works for both $vouches add and $reviews add)
      const addIdx = message.content.toLowerCase().indexOf(' add');
      const raw = addIdx !== -1 ? message.content.slice(addIdx + 4).trim() : '';
      if (!raw) return message.reply('Usage: `$vouches add text1,text2,text3`');

      // Split by comma, trim each, filter blanks
      const entries = raw.split(',').map(t => t.trim()).filter(Boolean);
      if (entries.length > 5000) return message.reply('Maximum 5000 vouches per batch.');

      const added = [];
      for (const text of entries) {
        const id = g.next_review_id++;
        g.reviews.push({ id, text });
        added.push(id);
      }
      await save();

      if (added.length === 1) {
        return message.reply(`added (ID: \`${added[0]}\`)\n> ${entries[0]}`);
      }
      return message.reply(`Added **${added.length}** vouch lines (IDs: \`${added[0]}\` - \`${added[added.length - 1]}\`).`);
    }

    if (sub === 'remove') {
      const id     = parseInt(args[1]);
      if (!id) return message.reply('Usage: `$vouches remove <id>`');
      const before = g.reviews.length;
      g.reviews    = g.reviews.filter(r => r.id !== id);
      await save();
      return message.reply(g.reviews.length < before ? `gone, removed \`${id}\`` : `couldnt find \`${id}\`, that ones not here`);
    }

    if (sub === 'list') {
      if (!g.reviews.length) return message.reply('aint got no vouch lines saved yet');
      // Split into pages of 20 if large
      const pages = [];
      for (let i = 0; i < g.reviews.length; i += 20) {
        pages.push(g.reviews.slice(i, i + 20).map(r => `\`${r.id}\` ${r.text}`).join('\n'));
      }
      // Send first page (Discord embed limit)
      const embed = new EmbedBuilder()
        .setTitle(`Saved Vouch Lines (${g.reviews.length} total)`)
        .setDescription(pages[0])
        .setColor('#5865F2')
        .setFooter({ text: pages.length > 1 ? `Page 1/${pages.length} - showing 20 at a time` : `${g.reviews.length} line(s)` });
      return message.channel.send({ embeds: [embed] });
    }

    return message.reply('Usage: `$vouches add text1,text2,text3` | `$vouches remove <id>` | `$vouches list`');
  }

  // ── $setvouch / $addvouch / $removevouch (aliases: setrep/addrep/removerep) ──
  if (['setvouch', 'addvouch', 'removevouch', 'setrep', 'addrep', 'removerep'].includes(command)) {
    const targetUser = message.mentions.users.first();
    const amount     = parseInt(args[1]);
    if (!targetUser || isNaN(amount)) {
      const verb = command.startsWith('set') ? 'set' : command.startsWith('add') ? 'add' : 'remove';
      return message.reply(`Usage: \`$${verb}vouch @user <amount>\``);
    }
    const isSet = command.startsWith('set');
    const isAdd = command.startsWith('add');
    const old      = getRepTotal(guildId, targetUser.id);
    const newTotal = isSet ? amount : isAdd ? old + amount : Math.max(0, old - amount);
    setRepTotal(guildId, targetUser.id, newTotal);
    return message.reply(`<@${targetUser.id}>'s vouches: **${old}** -> **${newTotal}**`);
  }

  // ── $setvouches @role <min>-<max> — bulk random assign + backfill history ──
  if (command === 'setvouches') {
    const role = message.mentions.roles.first();
    const rangeTok = args.find(a => /^\d+-\d+$/.test(a));
    if (!role || !rangeTok) {
      return message.reply('yo use it like this: `$setvouches @role 150-483` — drops a random vouch count in that range on everyone in the role + fills their history to match');
    }
    let [min, max] = rangeTok.split('-').map(Number);
    if (min > max) [min, max] = [max, min];

    const g = getGuild(guildId);
    if (!g.reviews.length) return message.reply('bro add some vouch lines first w/ `$vouches add <text>`, i cant fill history outta thin air');

    await guild.members.fetch();
    const members = guild.roles.cache.get(role.id)?.members.filter(m => !m.user.bot).toJSON() ?? [];
    if (!members.length) return message.reply('that role empty as hell (or just bots), gimme a real one');

    const status = await message.reply(`aight, settin up vouches for **${members.length}** member(s) (${min}-${max})... one sec`);

    const reviewerPool = g.config.reviewer_role
      ? (guild.roles.cache.get(g.config.reviewer_role)?.members.filter(m => !m.user.bot).map(m => m.id) ?? [])
      : members.map(m => m.id);

    const CAP = 350; // store up to 350 history rows per user; total still shows full number
    const now = Date.now();
    let totalAssigned = 0;

    for (const m of members) {
      const add = Math.floor(Math.random() * (max - min + 1)) + min;
      const old = getRepTotal(guildId, m.id);
      const newTotal = old + add;
      setRepTotal(guildId, m.id, newTotal);

      // How many NEW history rows to add for this batch (capped so the file stays light)
      const existing = g.rep_log.filter(r => r.target_user_id === m.id).length;
      const room     = Math.max(0, CAP - existing);
      const toStore  = Math.min(add, room);

      for (let i = 0; i < toStore; i++) {
        const reviewerId = reviewerPool.length ? reviewerPool[Math.floor(Math.random() * reviewerPool.length)] : m.id;
        const reviewText = pickRandom(g.reviews).text;
        const created    = now - Math.floor(Math.random() * 180 * 24 * 60 * 60 * 1000);
        g.rep_log.push({ target_user_id: m.id, reviewer_user_id: reviewerId, review_text: reviewText, created_at: created });
      }
      totalAssigned++;
    }

    await save();
    await updateLiveLeaderboard(guildId, guild);

    return status.edit(`done. dropped a random **${min}-${max}** vouches on **${totalAssigned}** member(s) of **${role.name}** and filled their history`);
  }

  // ── $setlbchannel #channel ────────────────────────────────────────────────────
  if (command === 'setlbchannel') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('Usage: `$setlbchannel #channel`');
    getGuild(guildId).config.lb_channel = channel.id;
    getGuild(guildId).config.lb_message_id = null;
    await save();
    await updateLiveLeaderboard(guildId, guild);
    return message.reply(`Live leaderboard set in <#${channel.id}>. It will update every 24h and on each vouch.`);
  }

  // ── $serverprofile — show this server's bot identity settings ─────────────
  if (command === 'serverprofile') {
    const g = getGuild(guildId);
    const embed = new EmbedBuilder()
      .setTitle(`Server Bot Profile — ${guild.name}`)
      .setColor(g.config.embed_color || '#5865F2')
      .addFields(
        { name: 'Bot Avatar',    value: g.config.server_avatar  ? '[Set]' : '_Default_', inline: true },
        { name: 'Bot Banner',   value: g.config.server_banner  ? '[Set]' : '_Default_', inline: true },
        { name: 'Watching',      value: g.config.server_watching || g.config.bot_watching || '_Default_', inline: true },
        { name: 'Embed Color',   value: g.config.embed_color    || '#5865F2', inline: true },
        { name: 'Embed Footer',  value: g.config.embed_footer   || 'Reputation System', inline: true },
        { name: 'Live LB',       value: g.config.lb_channel ? `<#${g.config.lb_channel}>` : '_Not set_', inline: true },
      )
      .setFooter({ text: 'Use $revamp to edit these settings' });
    return message.channel.send({ embeds: [embed] });
  }

  // ── $revamp (dropdown) ─────────────────────────────────────────────────────
  if (command === 'revamp') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`revamp_${guildId}_${message.author.id}`)
      .setPlaceholder('Choose a setting to change...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Embed Color').setValue('embed_color').setDescription('Hex color e.g. #FF0000').setEmoji(''),
        new StringSelectMenuOptionBuilder().setLabel('Embed Footer').setValue('embed_footer').setDescription('Footer text on vouch embeds').setEmoji(''),
        new StringSelectMenuOptionBuilder().setLabel('Embed Banner/Image').setValue('embed_image').setDescription('Image URL shown in vouch embeds').setEmoji(''),
        new StringSelectMenuOptionBuilder().setLabel('Bot Avatar (this server)').setValue('bot_avatar').setDescription('Change bot pfp for this server (image URL)').setEmoji(''),
        new StringSelectMenuOptionBuilder().setLabel('Bot Banner (this server)').setValue('bot_banner').setDescription('Change bot banner for this server').setEmoji(''),
        new StringSelectMenuOptionBuilder().setLabel('Bot Bio').setValue('bot_bio').setDescription('Change bot about me').setEmoji(''),
        new StringSelectMenuOptionBuilder().setLabel('Bot Watching (this server)').setValue('bot_watching').setDescription('Set watching status for this server').setEmoji(''),
      );

    const row    = new ActionRowBuilder().addComponents(menu);
    const prompt = await message.channel.send({ content: '**Revamp Settings** — choose what to change:', components: [row] });

    const collector = prompt.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: i => i.customId === `revamp_${guildId}_${message.author.id}` && i.user.id === message.author.id,
      time: 30000, max: 1,
    });

    collector.on('collect', async (interaction) => {
      const choice = interaction.values[0];
      const labels = {
        embed_color:  ' Embed Color — enter a hex code e.g. `#FF0000`',
        embed_footer: ' Embed Footer — enter the footer text',
        embed_image:  ' Embed Banner — enter a direct image URL',
        bot_avatar:   ' Bot Avatar — enter a direct image URL (PNG/JPG)',
        bot_banner:   ' Bot Banner — enter a direct image URL',
        bot_bio:      ' Bot Bio — enter the new about me text',
        bot_watching: ' Bot Watching — enter what the bot is watching e.g. `trades`',
      };
      await interaction.update({ content: `${labels[choice] || choice}\n\nType your value in chat now (30s):`, components: [] });

      const valueCollector = message.channel.createMessageCollector({
        filter: m => m.author.id === message.author.id,
        time: 30000, max: 1,
      });

      valueCollector.on('collect', async (valueMsg) => {
        const value = valueMsg.content.trim();
        const g     = getGuild(guildId);
        try {
          if (choice === 'embed_color') {
            if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return valueMsg.reply('Invalid hex. Use format `#FF0000`.');
            g.config.embed_color = value; await save();
            return valueMsg.reply(`Embed color set to \`${value}\`.`);
          }
          if (choice === 'embed_footer')  { g.config.embed_footer = value; await save(); return valueMsg.reply(`Embed footer set to: **${value}**`); }
          if (choice === 'embed_image')   { g.config.embed_image  = value; await save(); return valueMsg.reply(`Embed banner set.`); }
          if (choice === 'bot_avatar')    { await client.user.setAvatar(value); return valueMsg.reply(`Bot avatar updated.`); }
          if (choice === 'bot_banner')    { await client.user.setBanner(value); return valueMsg.reply(`Bot banner updated.`); }
          if (choice === 'bot_bio')       { await client.user.edit({ bio: value }); return valueMsg.reply(`Bot bio updated.`); }
          if (choice === 'bot_watching')  { g.config.bot_watching = value; await save(); client.user.setActivity(value, { type: ActivityType.Watching }); return valueMsg.reply(`Bot status: **Watching ${value}**`); }
        } catch (err) {
          return valueMsg.reply(`Failed: ${err.message}`);
        }
      });

      valueCollector.on('end', (c) => { if (!c.size) prompt.edit({ content: '⏱ Timed out.', components: [] }).catch(() => {}); });
    });

    collector.on('end', (c) => { if (!c.size) prompt.edit({ content: '⏱ Timed out.', components: [] }).catch(() => {}); });
    return;
  }

  // ── $setwatching ───────────────────────────────────────────────────────────
  if (command === 'setwatching') {
    const text = args.join(' ');
    if (!text) return message.reply('Usage: `$setwatching <text>`');
    getGuild(guildId).config.bot_watching = text;
    await save();
    client.user.setActivity(text, { type: ActivityType.Watching });
    return message.reply(`Bot status: **Watching ${text}**`);
  }

});


// ── Button interactions (Show More reviews) ───────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('showmore_')) return;

  const targetUserId = interaction.customId.split('_')[1];
  const guildId = interaction.guildId;

  try {
    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    if (!targetUser) return interaction.reply({ content: 'cant find that user', ephemeral: true });

    const embeds = buildAllReviewsEmbeds(guildId, targetUser);
    if (!embeds.length) return interaction.reply({ content: 'nothin to show here', ephemeral: true });

    // Reply privately so the channel doesn't get spammed
    await interaction.reply({ embeds, ephemeral: true });
  } catch (err) {
    console.error('[ShowMore error]:', err.message);
    if (!interaction.replied) interaction.reply({ content: 'somethin broke loadin those, try again', ephemeral: true }).catch(() => {});
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error(' Set DISCORD_TOKEN in your environment.'); process.exit(1); }
initDB().then(() => client.login(TOKEN));
