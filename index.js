require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionFlagsBits, ActivityType, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ActionRowBuilder, ComponentType
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
        // price alerts
        price_alert_channel: null,
        ltc_alert_target:   null,   // price target USD
        ltc_alert_pct:      null,   // % change threshold
        ltc_last_price:     null,
        ltc_alert_users:    [],     // user ids subscribed
        bot_status:         'online', // online | idle | dnd | invisible
      },
      reviews:        [],
      rep_totals:     {},
      rep_log:        [],
      next_review_id: 1,
      wallets:        {},
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

      await channel.send({
        content: `<@${targetUser.id}> has received a vouch from <@${reviewerUser.id}> and has received **+1** — look down to see more info`,
        embeds:  [buildVouchEmbed(guildId, targetUser, reviewerUser, newTotal, reviewText)],
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
  if (total >= 100) return { name: '👑 Legend',  nextAt: null };
  if (total >= 50)  return { name: '💎 Elite',   nextAt: 100  };
  if (total >= 25)  return { name: '⭐ Trusted', nextAt: 50   };
  if (total >= 10)  return { name: '🔵 Known',   nextAt: 25   };
  return               { name: '⚪ Starter', nextAt: 10   };
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
  const recent = getRecentReviews(guildId, targetUser.id, 10);
  const botIcon = config.server_avatar || null;

  // Recent reviews — up to 10, numbered
  const recentLines = recent.length
    ? recent.map((r, i) => {
        const ts = Math.floor(r.created_at / 1000);
        return `\`${String(i + 1).padStart(2, '0')}\` ${r.review_text} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
      }).join('\n')
    : '_No previous reviews yet_';

  const embed = new EmbedBuilder()
    .setColor(config.embed_color || '#5865F2')
    .setAuthor({
      name:    `${targetUser.username} `,
      iconURL: targetUser.displayAvatarURL({ dynamic: true }),
    })
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
    .addFields(
      { name: '📦 Total Vouches', value: `**${total}**`,                  inline: true },
      { name: '🏅 Rank',          value: rank.name,                       inline: true },
      { name: '📈 Progress',      value: progressBar(total, rank.nextAt), inline: true },
      { name: '📝 Latest Review', value: `> ${reviewText}`,               inline: false },
      { name: `📋 Recent Reviews (last ${Math.min(recent.length, 10)})`, value: recentLines, inline: false },
    )
    .setFooter({
      text:    `Vouched by ${reviewerUser.username} • ${config.embed_footer || 'Reputation System'}`,
      iconURL: reviewerUser.displayAvatarURL({ dynamic: true }),
    })
    .setTimestamp();

  if (config.embed_image) embed.setImage(config.embed_image);
  return embed;
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
    10:   { title: '🔵 First Milestone!',    desc: `Just hit **10 vouches** — officially Known in this server.` },
    25:   { title: '⭐ Trusted Status!',      desc: `Hit **25 vouches** and earned the Trusted rank.` },
    50:   { title: '💎 Elite Territory!',     desc: `**50 vouches** reached — Elite rank unlocked.` },
    100:  { title: '👑 Legend Achieved!',     desc: `**100 vouches** — reached Legend status.` },
    250:  { title: '🚀 250 Vouches!',         desc: `A true staple of this server with **250 vouches**.` },
    500:  { title: '💥 500 Vouches!',         desc: `**500 vouches** and still going. Unstoppable.` },
    1000: { title: '🏆 1000 Vouches!',        desc: `**1,000 vouches**. An absolute legend of this community.` },
  };

  const m = milestoneMessages[total];
  const milestoneColors = { 10: '#3498DB', 25: '#2ECC71', 50: '#9B59B6', 100: '#FFD700', 250: '#E74C3C', 500: '#FF6B35', 1000: '#FF0080' };

  const embed = new EmbedBuilder()
    .setColor(milestoneColors[total] || '#FFD700')
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
    .setTitle(m.title)
    .setDescription(`<@${targetUser.id}> ${m.desc}`)
    .addFields(
      { name: '📦 Total Vouches', value: `**${total}**`, inline: true },
      { name: '🏅 Current Rank',  value: rank.name,       inline: true },
      { name: '​',           value: '​',         inline: true },
    )
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
    .setImage(config.embed_image || null)
    .setFooter({ text: config.embed_footer || 'Reputation System' })
    .setTimestamp();

  // Post in vouch channel
  try {
    const ch = guild.channels.cache.get(config.vouch_channel);
    if (ch) await ch.send({ content: `🎉 Milestone reached for <@${targetUser.id}>!`, embeds: [embed] });
  } catch {}

  // DM the user
  try { await targetUser.send({ content: `🎉 You just hit a milestone in **${guild.name}**!`, embeds: [embed] }); } catch {}
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

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = sorted.map(([uid, total], i) =>
      `${medals[i] ?? `\`${i + 1}.\``} <@${uid}> — **${total}** vouches  •  ${getRank(total).name}`
    );

    const embed = new EmbedBuilder()
      .setTitle('🏆 Live Vouch Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(g.config.embed_color || '#5865F2')
      .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
      .setFooter({ text: `🔄 Updates every 24h  •  ${g.config.embed_footer || 'Reputation System'}` })
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

// ── LTC price alert checker ───────────────────────────────────────────────────
let ltcLastPrice = {};

async function checkLtcAlerts() {
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,gbp,php');
    const data = await res.json();
    const currentPrice = data.litecoin?.usd;
    if (!currentPrice) return;

    for (const [guildId, guildData] of Object.entries(db.data.guilds)) {
      const config = guildData.config;
      if (!config) continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const lastPrice = config.ltc_last_price;

      // Update stored price
      guildData.config.ltc_last_price = currentPrice;

      if (!lastPrice) continue;

      const pctChange = ((currentPrice - lastPrice) / lastPrice) * 100;
      const alerts    = [];

      // Always alert when LTC goes up (any positive movement)
      if (pctChange > 0) {
        alerts.push({
          type:  '📈 LTC is Going Up!',
          desc:  `LTC is up **+${pctChange.toFixed(2)}%** since the last check.`,
          color: '#57F287',
        });
      }

      // Also alert on big drops if threshold is set
      if (config.ltc_alert_pct && pctChange < 0 && Math.abs(pctChange) >= config.ltc_alert_pct) {
        alerts.push({
          type:  '📉 LTC Price Drop Alert',
          desc:  `LTC dropped **${pctChange.toFixed(2)}%** — crossed your ${config.ltc_alert_pct}% drop threshold.`,
          color: '#ED4245',
        });
      }

      // Price target alert (only fires once when crossed)
      if (config.ltc_alert_target) {
        const crossed = (lastPrice < config.ltc_alert_target && currentPrice >= config.ltc_alert_target)
          || (lastPrice > config.ltc_alert_target && currentPrice <= config.ltc_alert_target);
        if (crossed) {
          alerts.push({
            type:  '🎯 LTC Price Target Hit!',
            desc:  `LTC just crossed your target of **$${config.ltc_alert_target}**.`,
            color: '#F0B90B',
          });
          guildData.config.ltc_alert_target = null; // clear after firing
        }
      }

      if (!alerts.length) continue;

      for (const alert of alerts) {
        const embed = new EmbedBuilder()
          .setTitle(alert.type)
          .setColor(alert.color)
          .setDescription(alert.desc)
          .addFields(
            { name: '💵 Current USD', value: `$${currentPrice.toLocaleString()}`,              inline: true },
            { name: '💷 GBP',         value: `£${data.litecoin.gbp?.toLocaleString() ?? 'N/A'}`, inline: true },
            { name: '🇵🇭 PHP',       value: `₱${data.litecoin.php?.toLocaleString() ?? 'N/A'}`, inline: true },
          )
          .setFooter({ text: 'LTC Price Alert' })
          .setTimestamp();

        // Post in alert channel if set
        try {
          const ch = guild.channels.cache.get(config.price_alert_channel);
          if (ch) await ch.send({ embeds: [embed] });
        } catch {}

        // DM subscribed users
        for (const uid of (config.ltc_alert_users || [])) {
          try {
            const user = await client.users.fetch(uid);
            await user.send({ embeds: [embed] });
          } catch {}
        }
      }
    }

    await db.write();
  } catch (err) {
    console.error('[LTC Alert error]:', err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`✅ Online as ${client.user.tag}`);

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

  // LTC price alert — check every 5 minutes
  setInterval(checkLtcAlerts, 5 * 60 * 1000);
  checkLtcAlerts(); // run once on startup
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
    const ownerLine  = g.config.server_owner ? `👑 <@${g.config.server_owner}> — Server Owner` : null;
    const adminLines = g.config.admins?.length
      ? g.config.admins.map((id, i) => `\`${i + 1}.\` <@${id}>`)
      : ['_No admins set_'];

    const embed = new EmbedBuilder()
      .setTitle('🔐 Bot Access — ' + guild.name)
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
        { name: '📦 Total Vouches',  value: `**${total}**`,                  inline: true  },
        { name: '🏅 Rank',           value: rank.name,                       inline: true  },
        { name: '\u200b',            value: '\u200b',                        inline: true  },
        { name: '📈 Progress',       value: progressBar(total, rank.nextAt),  inline: false },
        { name: '📋 Recent Reviews', value: recentLines,                     inline: false },
        { name: '🎭 Roles',          value: roles,                           inline: false },
        { name: '📅 Joined',         value: joined,                          inline: true  },
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
    const medals = ['🥇', '🥈', '🥉'];
    const lines  = sorted.map(([userId, total], i) =>
      `${medals[i] ?? `\`${i + 1}.\``} <@${userId}> — **${total}** vouches  •  ${getRank(total).name}`
    );
    const embed = new EmbedBuilder()
      .setTitle('🏆 Vouch Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(getGuild(guildId).config.embed_color || '#5865F2')
      .setFooter({ text: getGuild(guildId).config.embed_footer || 'Reputation System' })
      .setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  // $recentreviews — anyone can use
  if (command === 'recentreviews') {
    const targetUser = message.mentions.users.first() || message.author;
    const recent     = getRecentReviews(guildId, targetUser.id, 10);
    if (!recent.length) return message.reply(`No reviews found for <@${targetUser.id}>.`);
    const lines = recent.map((r, i) => {
      const ts = Math.floor(r.created_at / 1000);
      return `\`${i + 1}.\` ${r.review_text} — <@${r.reviewer_user_id}> <t:${ts}:d>`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`📋 Recent Reviews — ${targetUser.username}`)
      .setDescription(lines.join('\n'))
      .setColor('#5865F2').setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  // $autoconfig — anyone can use
  if (command === 'autoconfig') {
    const embed = new EmbedBuilder()
      .setTitle('AutoVouch Cmmds look below dont look stupid asking me')
      .setColor('#5865F2')
      .addFields(
        { name: ' Auto Vouch (Admin)', value: '`$setautotarget @role` — Role to vouch one by one\n`$setreviewerrole @role` — Reviewer pool\n`$setrate <n>/min` or `<n>/sec` — Speed\n`$setvouchespermin <n>` — e.g. `$setvouchespermin 70`\n`$startauto` / `$stopauto` — Start or stop\n`$autostatus` — Current status' },
        { name: ' Manual Vouch (Admin)',  value: '`$postrep @target @reviewer` — Post a manual vouch\n`$repdemo` — Preview embed' },
        { name: ' Setup (Admin)',         value: '`$settargetrole @role`\n`$setvouchchannel #ch`\n`$repstatus`' },
        { name: ' Reviews (Admin)',       value: '`$reviews add text1,text2,text3` — Comma-separated bulk add\n`$reviews remove <id>`\n`$reviews list`' },
        { name: ' Rep Management (Admin)', value: '`$setrep @user <n>`\n`$addrep @user <n>`\n`$removerep @user <n>`' },
        { name: ' Customization (Admin)', value: '`$revamp` — Dropdown (embed color, footer, banner, bot pfp, bio, watching)\n`$setwatching <text>` — Quick watching status\n`$serverprofile` — View this server\'s bot settings' },
        { name: ' Live Leaderboard (Admin)', value: '`$setlbchannel #channel` — Post a live leaderboard that updates every 24h' },
        { name: ' LTC Price Alerts (Admin)', value: '`$setalertchannel #channel` — Where alerts post\n`$ltcalert target 120` — Alert at price target\n`$ltcalert pct 5` — Alert on % change\n`$ltcsubscribe` / `$ltcunsubscribe` — DM alerts' },
        { name: ' Access Control (Admin)', value: '`$setadmins @u1 @u2...` — Set up to 5 bot admins\n`$setbotowner` — Claim bot ownership for this server (first run)\n`$setbotowner @user` — Transfer ownership to someone else' },
        { name: ' Public (Anyone)', value: '`$profile [@user]`\n`$leaderboard`\n`$recentreviews [@user]`\n`$admins` — Who are the admins\n`$price <coin>` — Live price\n`$mybal` — Your wallet balances\n`$setaddy <chain> <address>` — Save wallet\n`$ltcsubscribe` / `$ltcunsubscribe` — LTC DM alerts\n`$autoconfig` / `$help2` — Help menus' },
        { name: ' Bot Status (Admin)', value: '`$setbotstatus <online|idle|dnd|offline>` — Change bot presence' },
      )
      .setFooter({ text: 'Reputation System' });
    return message.channel.send({ embeds: [embed] });
  }

  // ── $ltcsubscribe / $ltcunsubscribe — public, anyone can opt in ─────────────
  if (command === 'ltcsubscribe') {
    const g = getGuild(guildId);
    if (!g.config.ltc_alert_users) g.config.ltc_alert_users = [];
    if (g.config.ltc_alert_users.includes(message.author.id))
      return message.reply('You are already subscribed to LTC alerts in this server.');
    g.config.ltc_alert_users.push(message.author.id);
    await save();
    return message.reply('✅ Subscribed! You will receive DM alerts when LTC moves in this server.');
  }

  if (command === 'ltcunsubscribe') {
    const g = getGuild(guildId);
    g.config.ltc_alert_users = (g.config.ltc_alert_users || []).filter(id => id !== message.author.id);
    await save();
    return message.reply('✅ Unsubscribed from LTC price alert DMs.');
  }

  // ── ALL COMMANDS BELOW ARE ADMIN ONLY ─────────────────────────────────────
  if (!hasAccess(member, guildId)) return message.reply('❌ You don\'t have permission to use this command.');

  // ── $setbotstatus ─────────────────────────────────────────────────────────
  if (command === 'setbotstatus') {
    const status = args[0]?.toLowerCase();
    const valid  = { online: 'online', idle: 'idle', dnd: 'dnd', offline: 'invisible', invisible: 'invisible' };
    if (!status || !valid[status]) {
      return message.reply('❌ Usage: `$setbotstatus <online|idle|dnd|offline>`');
    }
    const presence = valid[status];
    await client.user.setPresence({ status: presence });
    getGuild(guildId).config.bot_status = presence;
    await save();
    const labels = { online: '🟢 Online', idle: '🌙 Idle', dnd: '⛔ Do Not Disturb', invisible: '⚫ Offline/Invisible' };
    return message.reply(`✅ Bot status set to **${labels[presence]}**.`);
  }

  // ── $setserverowner / $setbotowner ───────────────────────────────────────────
  if (command === 'setserverowner' || command === 'setbotowner') {
    const g = getGuild(guildId);
    if (g.config.server_owner) {
      // Already set — only current owner can reassign
      if (g.config.server_owner !== message.author.id) return;
      const newOwner = message.mentions.users.first();
      if (!newOwner) return message.reply('❌ You are already the owner. Mention a user to transfer: `$setbotowner @user`');
      g.config.server_owner = newOwner.id;
      await save();
      return message.reply(`✅ Bot ownership for **${guild.name}** transferred to <@${newOwner.id}>.`);
    }
    g.config.server_owner = message.author.id;
    await save();
    return message.reply(`✅ You are now the **Bot Owner** for **${guild.name}**. Only you can transfer this role.
Use \`$setbotowner @user\` to transfer ownership.`);
  }

  // ── $setadmins ─────────────────────────────────────────────────────────────
  if (command === 'setadmins') {
    const mentions = [...message.mentions.users.values()].slice(0, 5);
    if (!mentions.length) return message.reply('❌ Usage: `$setadmins @user1 @user2 ...` (up to 5)');
    getGuild(guildId).config.admins = mentions.map(u => u.id);
    await save();
    return message.reply(`✅ Bot admins set: ${mentions.map(u => `<@${u.id}>`).join(', ')}`);
  }

  // ── $postrep @target @reviewer ─────────────────────────────────────────────
  if (command === 'postrep' || command === 'giverep') {
    const mentions = [...message.mentions.users.values()];
    if (mentions.length < 2) return message.reply('❌ Usage: `$postrep @target @reviewer`');
    const targetUser   = mentions[0];
    const reviewerUser = mentions[1];
    if (targetUser.bot || reviewerUser.bot) return message.reply('❌ Bots cannot be used.');

    const g = getGuild(guildId);
    if (!g.config.vouch_channel) return message.reply('❌ No vouch channel set.');
    if (!g.reviews.length) return message.reply('❌ No reviews saved.');

    if (g.config.target_role || g.config.reviewer_role) await guild.members.fetch();
    if (g.config.target_role) {
      const t = guild.members.cache.get(targetUser.id);
      if (!t?.roles.cache.has(g.config.target_role))
        return message.reply(`❌ <@${targetUser.id}> doesn't have the target role.`);
    }
    if (g.config.reviewer_role) {
      const r = guild.members.cache.get(reviewerUser.id);
      if (!r?.roles.cache.has(g.config.reviewer_role))
        return message.reply(`❌ <@${reviewerUser.id}> doesn't have the reviewer role.`);
    }

    const reviewText = pickRandom(g.reviews).text;
    const newTotal   = getRepTotal(guildId, targetUser.id) + 1;
    setRepTotal(guildId, targetUser.id, newTotal);
    g.rep_log.push({ target_user_id: targetUser.id, reviewer_user_id: reviewerUser.id, review_text: reviewText, created_at: Date.now() });
    await save();

    const channel = guild.channels.cache.get(g.config.vouch_channel);
    if (!channel) return message.reply('❌ Vouch channel not found.');
    await channel.send({
      content: `<@${targetUser.id}> has received a vouch from <@${reviewerUser.id}> and has received **+1** — look down to see more info`,
      embeds:  [buildVouchEmbed(guildId, targetUser, reviewerUser, newTotal, reviewText)],
    });
    await checkMilestone(guildId, guild, targetUser, newTotal);
    await updateLiveLeaderboard(guildId, guild);
    if (channel.id !== message.channel.id) message.reply(`✅ Vouch posted in <#${channel.id}>.`);
    return;
  }

  // ── $setautotarget @role ───────────────────────────────────────────────────
  if (command === 'setautotarget') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply('❌ Usage: `$setautotarget @role`');
    const g = getGuild(guildId);
    g.config.auto_target_role = role.id;
    g.config.auto_queue       = [];
    await save();
    return message.reply(`✅ Auto target role set to **${role.name}**. Members will be vouched one by one.`);
  }

  // ── $setreviewerrole ───────────────────────────────────────────────────────
  if (command === 'setreviewerrole') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply('❌ Usage: `$setreviewerrole @role`');
    getGuild(guildId).config.reviewer_role = role.id;
    await save();
    return message.reply(`✅ Reviewer role set to **${role.name}**.`);
  }

  // ── $setrate ───────────────────────────────────────────────────────────────
  if (command === 'setrate') {
    const input = args[0];
    if (!input) return message.reply('❌ Usage: `$setrate <n>/min` or `$setrate <n>/sec`\nExamples: `$setrate 60/min` `$setrate 10/sec` `$setrate 3`');
    const ms = parseRate(input);
    if (!ms) return message.reply('❌ Invalid rate. Examples: `$setrate 60/min` `$setrate 5/sec` (max 60/sec)');
    getGuild(guildId).config.auto_rate_ms = ms;
    await save();
    // Restart timer if running
    const g = getGuild(guildId);
    if (g.config.auto_running) startAutoTimer(guildId, guild);
    return message.reply(`✅ Rate set to **${rateLabel(ms)}**.`);
  }

  // ── $setvouchespermin <n> ────────────────────────────────────────────────────
  if (command === 'setvouchespermin') {
    const n = parseInt(args[0]);
    if (!n || n < 1 || n > 3600) return message.reply('❌ Usage: `$setvouchespermin <number>` e.g. `$setvouchespermin 70`');
    const ms = Math.floor(60000 / n);
    getGuild(guildId).config.auto_rate_ms = ms;
    await save();
    const g = getGuild(guildId);
    if (g.config.auto_running) startAutoTimer(guildId, guild);
    return message.reply(`✅ Rate set to **${n} vouches per minute** (one every ~${(ms/1000).toFixed(1)}s).`);
  }

  // ── $startauto ─────────────────────────────────────────────────────────────
  if (command === 'startauto') {
    const g = getGuild(guildId);
    if (!g.config.vouch_channel)    return message.reply('❌ Set vouch channel first: `$setvouchchannel #ch`');
    if (!g.config.reviewer_role)    return message.reply('❌ Set reviewer role first: `$setreviewerrole @role`');
    if (!g.config.auto_target_role) return message.reply('❌ Set auto target role first: `$setautotarget @role`');
    if (!g.reviews.length)          return message.reply('❌ Add reviews first: `$reviews add <text>`');
    g.config.auto_running = true;
    await save();
    startAutoTimer(guildId, guild);
    return message.reply(`✅ Auto vouch started! **${rateLabel(g.config.auto_rate_ms)}** — vouching <@&${g.config.auto_target_role}> one by one.`);
  }

  // ── $stopauto ──────────────────────────────────────────────────────────────
  if (command === 'stopauto') {
    getGuild(guildId).config.auto_running = false;
    await save();
    stopAutoTimer(guildId);
    return message.reply('⏹️ Auto vouch stopped.');
  }

  // ── $autostatus ────────────────────────────────────────────────────────────
  if (command === 'autostatus') {
    const g     = getGuild(guildId);
    const embed = new EmbedBuilder()
      .setTitle('⚙️ Auto Vouch Status')
      .setColor(g.config.auto_running ? '#57F287' : '#ED4245')
      .addFields(
        { name: 'Status',        value: g.config.auto_running ? '🟢 Running' : '🔴 Stopped',                         inline: true  },
        { name: 'Rate',          value: rateLabel(g.config.auto_rate_ms || 60000),                                    inline: true  },
        { name: 'Queue Left',    value: `${g.config.auto_queue?.length ?? 0} members`,                               inline: true  },
        { name: 'Target Role',   value: g.config.auto_target_role ? `<@&${g.config.auto_target_role}>` : '_Not set_', inline: true  },
        { name: 'Reviewer Role', value: g.config.reviewer_role    ? `<@&${g.config.reviewer_role}>`    : '_Not set_', inline: true  },
        { name: 'Vouch Channel', value: g.config.vouch_channel    ? `<#${g.config.vouch_channel}>`    : '_Not set_', inline: true  },
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
    if (!role) return message.reply('❌ Usage: `$settargetrole @role`');
    getGuild(guildId).config.target_role = role.id;
    await save();
    return message.reply(`✅ Target role set to **${role.name}**.`);
  }

  // ── $setvouchchannel ───────────────────────────────────────────────────────
  if (command === 'setvouchchannel') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('❌ Usage: `$setvouchchannel #channel`');
    getGuild(guildId).config.vouch_channel = channel.id;
    await save();
    return message.reply(`✅ Vouch channel set to <#${channel.id}>.`);
  }

  // ── $repstatus ─────────────────────────────────────────────────────────────
  if (command === 'repstatus') {
    const g = getGuild(guildId);
    const embed = new EmbedBuilder()
      .setTitle('⚙️ Rep System Config')
      .setColor('#5865F2')
      .addFields(
        { name: 'Target Role',     value: g.config.target_role   ? `<@&${g.config.target_role}>`   : '_Not set_', inline: true },
        { name: 'Reviewer Role',   value: g.config.reviewer_role ? `<@&${g.config.reviewer_role}>` : '_Not set_', inline: true },
        { name: 'Vouch Channel',   value: g.config.vouch_channel ? `<#${g.config.vouch_channel}>` : '_Not set_',  inline: true },
        { name: 'Reviews in Pool', value: `${g.reviews.length}`,                                                  inline: true },
        { name: 'Bot Admins',      value: g.config.admins?.length ? g.config.admins.map(id => `<@${id}>`).join(', ') : '_None_', inline: false },
      )
      .setFooter({ text: guild.name });
    return message.channel.send({ embeds: [embed] });
  }

  // ── $reviews ───────────────────────────────────────────────────────────────
  if (command === 'reviews') {
    const sub = args[0]?.toLowerCase();
    const g   = getGuild(guildId);

    if (sub === 'add') {
      // Everything after "add" is the raw input
      const raw = message.content.slice(message.content.toLowerCase().indexOf('reviews add') + 'reviews add'.length).trim();
      if (!raw) return message.reply('❌ Usage: `$reviews add text1,text2,text3`');

      // Split by comma, trim each, filter blanks
      const entries = raw.split(',').map(t => t.trim()).filter(Boolean);
      if (entries.length > 5000) return message.reply('❌ Maximum 5000 reviews per batch.');

      const added = [];
      for (const text of entries) {
        const id = g.next_review_id++;
        g.reviews.push({ id, text });
        added.push(id);
      }
      await save();

      if (added.length === 1) {
        return message.reply(`✅ Review added (ID: \`${added[0]}\`)\n> ${entries[0]}`);
      }
      return message.reply(`✅ Added **${added.length}** reviews (IDs: \`${added[0]}\` – \`${added[added.length - 1]}\`).`);
    }

    if (sub === 'remove') {
      const id     = parseInt(args[1]);
      if (!id) return message.reply('❌ Usage: `$reviews remove <id>`');
      const before = g.reviews.length;
      g.reviews    = g.reviews.filter(r => r.id !== id);
      await save();
      return message.reply(g.reviews.length < before ? `✅ Review \`${id}\` removed.` : `❌ Review \`${id}\` not found.`);
    }

    if (sub === 'list') {
      if (!g.reviews.length) return message.reply('No reviews saved yet.');
      // Split into pages of 20 if large
      const pages = [];
      for (let i = 0; i < g.reviews.length; i += 20) {
        pages.push(g.reviews.slice(i, i + 20).map(r => `\`${r.id}\` ${r.text}`).join('\n'));
      }
      // Send first page (Discord embed limit)
      const embed = new EmbedBuilder()
        .setTitle(`📋 Saved Reviews (${g.reviews.length} total)`)
        .setDescription(pages[0])
        .setColor('#5865F2')
        .setFooter({ text: pages.length > 1 ? `Page 1/${pages.length} — showing 20 at a time` : `${g.reviews.length} review(s)` });
      return message.channel.send({ embeds: [embed] });
    }

    return message.reply('Usage: `$reviews add text1,text2,text3` | `$reviews remove <id>` | `$reviews list`');
  }

  // ── $setrep / $addrep / $removerep ─────────────────────────────────────────
  if (['setrep', 'addrep', 'removerep'].includes(command)) {
    const targetUser = message.mentions.users.first();
    const amount     = parseInt(args[1]);
    if (!targetUser || isNaN(amount)) return message.reply(`❌ Usage: \`$${command} @user <amount>\``);
    const old      = getRepTotal(guildId, targetUser.id);
    const newTotal = command === 'setrep' ? amount : command === 'addrep' ? old + amount : Math.max(0, old - amount);
    setRepTotal(guildId, targetUser.id, newTotal);
    return message.reply(`✅ <@${targetUser.id}>'s rep: **${old}** → **${newTotal}**`);
  }

  // ── $setlbchannel #channel ────────────────────────────────────────────────────
  if (command === 'setlbchannel') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('❌ Usage: `$setlbchannel #channel`');
    getGuild(guildId).config.lb_channel = channel.id;
    getGuild(guildId).config.lb_message_id = null;
    await save();
    await updateLiveLeaderboard(guildId, guild);
    return message.reply(`✅ Live leaderboard set in <#${channel.id}>. It will update every 24h and on each vouch.`);
  }

  // ── $setalertchannel #channel ─────────────────────────────────────────────
  if (command === 'setalertchannel') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('❌ Usage: `$setalertchannel #channel`');
    getGuild(guildId).config.price_alert_channel = channel.id;
    await save();
    return message.reply(`✅ Price alerts will post in <#${channel.id}>.`);
  }

  // ── $ltcalert target <price> OR pct <percent> ────────────────────────────
  if (command === 'ltcalert') {
    const sub = args[0]?.toLowerCase();
    const val = parseFloat(args[1]);
    if (!sub || isNaN(val)) return message.reply('❌ Usage: `$ltcalert target 120` or `$ltcalert pct 5`');
    const g = getGuild(guildId);
    if (sub === 'target') { g.config.ltc_alert_target = val; await save(); return message.reply(`✅ LTC price target alert set at **$${val}**.`); }
    if (sub === 'pct')    { g.config.ltc_alert_pct = val;    await save(); return message.reply(`✅ LTC % change alert set at **${val}%**.`); }
    return message.reply('❌ Use `target` or `pct`: `$ltcalert target 120` / `$ltcalert pct 5`');
  }

  // ── $serverprofile — show this server's bot identity settings ─────────────
  if (command === 'serverprofile') {
    const g = getGuild(guildId);
    const embed = new EmbedBuilder()
      .setTitle(`🎨 Server Bot Profile — ${guild.name}`)
      .setColor(g.config.embed_color || '#5865F2')
      .addFields(
        { name: '👤 Bot Avatar',    value: g.config.server_avatar  ? '[Set]'   : '_Default_', inline: true },
        { name: '🏳️ Bot Banner',   value: g.config.server_banner  ? '[Set]'   : '_Default_', inline: true },
        { name: '👀 Watching',      value: g.config.server_watching || g.config.bot_watching || '_Default_', inline: true },
        { name: '🎨 Embed Color',   value: g.config.embed_color    || '#5865F2', inline: true },
        { name: '📝 Embed Footer',  value: g.config.embed_footer   || 'Reputation System', inline: true },
        { name: '📢 Alert Channel', value: g.config.price_alert_channel ? `<#${g.config.price_alert_channel}>` : '_Not set_', inline: true },
        { name: '🏆 Live LB',       value: g.config.lb_channel ? `<#${g.config.lb_channel}>` : '_Not set_', inline: true },
        { name: '🎯 LTC Target',    value: g.config.ltc_alert_target ? `$${g.config.ltc_alert_target}` : '_Not set_', inline: true },
        { name: '📊 LTC % Alert',   value: g.config.ltc_alert_pct ? `${g.config.ltc_alert_pct}%` : '_Not set_', inline: true },
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
        new StringSelectMenuOptionBuilder().setLabel('Embed Color').setValue('embed_color').setDescription('Hex color e.g. #FF0000').setEmoji('🎨'),
        new StringSelectMenuOptionBuilder().setLabel('Embed Footer').setValue('embed_footer').setDescription('Footer text on vouch embeds').setEmoji('📝'),
        new StringSelectMenuOptionBuilder().setLabel('Embed Banner/Image').setValue('embed_image').setDescription('Image URL shown in vouch embeds').setEmoji('🖼️'),
        new StringSelectMenuOptionBuilder().setLabel('Bot Avatar (this server)').setValue('bot_avatar').setDescription('Change bot pfp for this server (image URL)').setEmoji('👤'),
        new StringSelectMenuOptionBuilder().setLabel('Bot Banner (this server)').setValue('bot_banner').setDescription('Change bot banner for this server').setEmoji('🏳️'),
        new StringSelectMenuOptionBuilder().setLabel('Bot Bio').setValue('bot_bio').setDescription('Change bot about me').setEmoji('💬'),
        new StringSelectMenuOptionBuilder().setLabel('Bot Watching (this server)').setValue('bot_watching').setDescription('Set watching status for this server').setEmoji('👀'),
      );

    const row    = new ActionRowBuilder().addComponents(menu);
    const prompt = await message.channel.send({ content: '🎛️ **Revamp Settings** — choose what to change:', components: [row] });

    const collector = prompt.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: i => i.customId === `revamp_${guildId}_${message.author.id}` && i.user.id === message.author.id,
      time: 30000, max: 1,
    });

    collector.on('collect', async (interaction) => {
      const choice = interaction.values[0];
      const labels = {
        embed_color:  '🎨 Embed Color — enter a hex code e.g. `#FF0000`',
        embed_footer: '📝 Embed Footer — enter the footer text',
        embed_image:  '🖼️ Embed Banner — enter a direct image URL',
        bot_avatar:   '👤 Bot Avatar — enter a direct image URL (PNG/JPG)',
        bot_banner:   '🏳️ Bot Banner — enter a direct image URL',
        bot_bio:      '💬 Bot Bio — enter the new about me text',
        bot_watching: '👀 Bot Watching — enter what the bot is watching e.g. `trades`',
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
            if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return valueMsg.reply('❌ Invalid hex. Use format `#FF0000`.');
            g.config.embed_color = value; await save();
            return valueMsg.reply(`✅ Embed color set to \`${value}\`.`);
          }
          if (choice === 'embed_footer')  { g.config.embed_footer = value; await save(); return valueMsg.reply(`✅ Embed footer set to: **${value}**`); }
          if (choice === 'embed_image')   { g.config.embed_image  = value; await save(); return valueMsg.reply(`✅ Embed banner set.`); }
          if (choice === 'bot_avatar')    { await client.user.setAvatar(value); return valueMsg.reply(`✅ Bot avatar updated.`); }
          if (choice === 'bot_banner')    { await client.user.setBanner(value); return valueMsg.reply(`✅ Bot banner updated.`); }
          if (choice === 'bot_bio')       { await client.user.edit({ bio: value }); return valueMsg.reply(`✅ Bot bio updated.`); }
          if (choice === 'bot_watching')  { g.config.bot_watching = value; await save(); client.user.setActivity(value, { type: ActivityType.Watching }); return valueMsg.reply(`✅ Bot status: **Watching ${value}**`); }
        } catch (err) {
          return valueMsg.reply(`❌ Failed: ${err.message}`);
        }
      });

      valueCollector.on('end', (c) => { if (!c.size) prompt.edit({ content: '⏱️ Timed out.', components: [] }).catch(() => {}); });
    });

    collector.on('end', (c) => { if (!c.size) prompt.edit({ content: '⏱️ Timed out.', components: [] }).catch(() => {}); });
    return;
  }

  // ── $setwatching ───────────────────────────────────────────────────────────
  if (command === 'setwatching') {
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `$setwatching <text>`');
    getGuild(guildId).config.bot_watching = text;
    await save();
    client.user.setActivity(text, { type: ActivityType.Watching });
    return message.reply(`✅ Bot status: **Watching ${text}**`);
  }

  // ── CRYPTO COMMANDS (public) ───────────────────────────────────────────────

  // $price <symbol> — fetch live coin price
  if (command === 'price') {
    const symbol = args[0]?.toLowerCase();
    if (!symbol) return message.reply('❌ Usage: `$price <symbol>` e.g. `$price btc`');

    try {
      // Search CoinGecko for coin id
      const searchRes  = await fetch(`https://api.coingecko.com/api/v3/search?query=${symbol}`);
      const searchData = await searchRes.json();
      const coin       = searchData.coins?.find(c => c.symbol.toLowerCase() === symbol) || searchData.coins?.[0];
      if (!coin) return message.reply(`❌ Coin \`${symbol.toUpperCase()}\` not found.`);

      const priceRes  = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd,gbp,php&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`);
      const priceData = await priceRes.json();
      const data      = priceData[coin.id];
      if (!data) return message.reply(`❌ Could not fetch price for \`${coin.name}\`.`);

      const change   = data.usd_24h_change?.toFixed(2);
      const arrow    = change >= 0 ? '📈' : '📉';
      const changeStr = change >= 0 ? `+${change}%` : `${change}%`;

      const embed = new EmbedBuilder()
        .setTitle(`${coin.name} (${coin.symbol.toUpperCase()})`)
        .setColor(change >= 0 ? '#57F287' : '#ED4245')
        .setThumbnail(coin.large || null)
        .addFields(
          { name: '💵 USD',             value: `$${data.usd?.toLocaleString() ?? 'N/A'}`,            inline: true },
          { name: '💷 GBP',             value: `£${data.gbp?.toLocaleString() ?? 'N/A'}`,            inline: true },
          { name: '🇵🇭 PHP',           value: `₱${data.php?.toLocaleString() ?? 'N/A'}`,            inline: true },
          { name: `${arrow} 24h`,       value: changeStr,                                             inline: true },
          { name: '📊 Market Cap',      value: `$${(data.usd_market_cap || 0).toLocaleString()}`,    inline: true },
          { name: '🔄 24h Volume',      value: `$${(data.usd_24h_vol || 0).toLocaleString()}`,       inline: true },
        )
        .setFooter({ text: 'Prices via CoinGecko' })
        .setTimestamp();

      return message.channel.send({ embeds: [embed] });
    } catch (err) {
      return message.reply(`❌ Failed to fetch price: ${err.message}`);
    }
  }

  // $setaddy <chain> <address> — save your wallet address
  if (command === 'setaddy') {
    const chain   = args[0]?.toLowerCase();
    const address = args[1];
    const validChains = ['eth', 'btc', 'sol', 'bnb', 'matic', 'avax', 'ltc'];

    if (!chain || !address) return message.reply(`❌ Usage: \`$setaddy <chain> <address>\`\nSupported: ${validChains.join(', ')}`);
    if (!validChains.includes(chain)) return message.reply(`❌ Unsupported chain. Use: ${validChains.join(', ')}`);

    const g = getGuild(guildId);
    if (!g.wallets) g.wallets = {};
    if (!g.wallets[message.author.id]) g.wallets[message.author.id] = {};
    g.wallets[message.author.id][chain] = address;
    await save();
    return message.reply(`✅ Your **${chain.toUpperCase()}** address saved.\n\`${address}\``);
  }

  // $mybal [chain] — show wallet balances with fiat + last txns
  if (command === 'mybal') {
    const g = getGuild(guildId);
    if (!g.wallets) g.wallets = {};
    const userWallets = g.wallets[message.author.id];
    if (!userWallets || !Object.keys(userWallets).length)
      return message.reply('❌ No wallets saved. Use `$setaddy <chain> <address>` first.');

    const chainFilter = args[0]?.toLowerCase();
    const toCheck = chainFilter
      ? (userWallets[chainFilter] ? { [chainFilter]: userWallets[chainFilter] } : null)
      : userWallets;
    if (!toCheck) return message.reply(`❌ No wallet saved for \`${chainFilter}\`.`);

    const coinIds = { eth: 'ethereum', btc: 'bitcoin', sol: 'solana', bnb: 'binancecoin', matic: 'matic-network', avax: 'avalanche-2', ltc: 'litecoin' };
    const neededIds = [...new Set(Object.keys(toCheck).map(c => coinIds[c]).filter(Boolean))].join(',');
    let prices = {};
    try {
      const pr = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${neededIds}&vs_currencies=usd,gbp,php`);
      prices = await pr.json();
    } catch { /* continue without prices */ }

    const embed = new EmbedBuilder()
      .setTitle(`💼 Wallet Balances — ${message.author.username}`)
      .setColor('#5865F2')
      .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
      .setFooter({ text: 'Balances via public blockchain APIs • Prices via CoinGecko' })
      .setTimestamp();

    const fields = [];

    for (const [chain, address] of Object.entries(toCheck)) {
      try {
        let nativeAmount = 0;
        let balStr = '_Could not fetch_';
        let txLines = '_N/A_';

        // Balance
        if (['eth', 'bnb', 'matic', 'avax'].includes(chain)) {
          const apis = {
            eth:   `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest`,
            bnb:   `https://api.bscscan.com/api?module=account&action=balance&address=${address}&tag=latest`,
            matic: `https://api.polygonscan.com/api?module=account&action=balance&address=${address}&tag=latest`,
            avax:  `https://api.snowtrace.io/api?module=account&action=balance&address=${address}&tag=latest`,
          };
          const res = await fetch(apis[chain]); const data = await res.json();
          if (data.status === '1') { nativeAmount = parseInt(data.result) / 1e18; balStr = `${nativeAmount.toFixed(6)} ${chain.toUpperCase()}`; }
        } else if (chain === 'btc') {
          const res = await fetch(`https://blockchain.info/balance?active=${address}`); const data = await res.json();
          nativeAmount = (data[address]?.final_balance ?? 0) / 1e8;
          balStr = `${nativeAmount.toFixed(8)} BTC`;
        } else if (chain === 'sol') {
          const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }) });
          const data = await res.json();
          nativeAmount = (data.result?.value ?? 0) / 1e9;
          balStr = `${nativeAmount.toFixed(6)} SOL`;
        } else if (chain === 'ltc') {
          const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`);
          const data = await res.json();
          nativeAmount = (data.balance ?? 0) / 1e8;
          balStr = `${nativeAmount.toFixed(8)} LTC`;
        }

        // Fiat value
        const pid = coinIds[chain];
        const px = prices[pid];
        let fiatStr = '';
        if (px && nativeAmount > 0) {
          fiatStr = `\n💵 $${(nativeAmount * px.usd).toFixed(2)} USD  💷 £${(nativeAmount * px.gbp).toFixed(2)} GBP  🇵🇭 ₱${(nativeAmount * px.php).toFixed(2)} PHP`;
        }

        // Last 3 transactions
        try {
          if (chain === 'btc') {
            const tr = await fetch(`https://blockchain.info/rawaddr/${address}?limit=3`); const td = await tr.json();
            txLines = (td.txs || []).slice(0, 3).map(tx => {
              const val = (tx.out?.reduce((s, o) => o.addr === address ? s + o.value : s, 0) ?? 0) / 1e8;
              return `• ${val >= 0 ? '+' : ''}${val.toFixed(6)} BTC — <t:${tx.time}:d>`;
            }).join('\n') || '_None_';
          } else if (chain === 'ltc') {
            const tr = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/full?limit=3`); const td = await tr.json();
            txLines = (td.txs || []).slice(0, 3).map(tx => {
              const out = (tx.outputs?.reduce((s, o) => o.addresses?.includes(address) ? s + o.value : s, 0) ?? 0);
              const inp = (tx.inputs?.reduce((s, i) => i.addresses?.includes(address) ? s + i.output_value : s, 0) ?? 0);
              const net = (out - inp) / 1e8;
              const ts  = Math.floor(new Date(tx.confirmed || tx.received).getTime() / 1000);
              return `• ${net >= 0 ? '+' : ''}${net.toFixed(6)} LTC — <t:${ts}:d>`;
            }).join('\n') || '_None_';
          } else if (chain === 'sol') {
            const tr = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 3 }] }) });
            const td = await tr.json();
            txLines = (td.result || []).slice(0, 3).map(tx => `• \`${tx.signature.slice(0, 12)}...\` — <t:${tx.blockTime}:d>`).join('\n') || '_None_';
          } else if (['eth', 'bnb', 'matic', 'avax'].includes(chain)) {
            const txApis = {
              eth:   `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=3`,
              bnb:   `https://api.bscscan.com/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=3`,
              matic: `https://api.polygonscan.com/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=3`,
              avax:  `https://api.snowtrace.io/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=3`,
            };
            const tr = await fetch(txApis[chain]); const td = await tr.json();
            txLines = (td.result || []).slice(0, 3).map(tx => {
              const val = (parseInt(tx.value) / 1e18).toFixed(6);
              const dir = tx.to?.toLowerCase() === address.toLowerCase() ? '+' : '-';
              return `• ${dir}${val} ${chain.toUpperCase()} — <t:${tx.timeStamp}:d>`;
            }).join('\n') || '_None_';
          }
        } catch { txLines = '_Could not fetch txns_'; }

        fields.push({
          name:   `${chain.toUpperCase()} — \`${address.slice(0, 8)}...${address.slice(-6)}\``,
          value:  `**Balance:** ${balStr}${fiatStr}\n**Last Txns:**\n${txLines}`,
          inline: false,
        });
      } catch {
        fields.push({ name: chain.toUpperCase(), value: '_Error fetching data_', inline: false });
      }
    }

    embed.addFields(fields);
    return message.channel.send({ embeds: [embed] });
  }

  // $bal @user [chain] — check another user's saved wallet (public)
  if (command === 'bal') {
    const targetUser = message.mentions.users.first();
    if (!targetUser) return message.reply('❌ Usage: `$bal @user [chain]`');
    const g          = getGuild(guildId);
    if (!g.wallets) g.wallets = {};
    const userWallets = g.wallets[targetUser.id];
    if (!userWallets || !Object.keys(userWallets).length)
      return message.reply(`❌ <@${targetUser.id}> has no saved wallets.`);

    const lines = Object.entries(userWallets).map(([chain, addr]) =>
      `**${chain.toUpperCase()}:** \`${addr.slice(0, 8)}...${addr.slice(-6)}\``
    );
    const embed = new EmbedBuilder()
      .setTitle(`💼 Saved Wallets — ${targetUser.username}`)
      .setDescription(lines.join('\n'))
      .setColor('#5865F2')
      .setFooter({ text: 'Use $mybal to see live balances' });
    return message.channel.send({ embeds: [embed] });
  }

  // ── $help2 ─────────────────────────────────────────────────────────────────
  if (command === 'help2') {
    const embed = new EmbedBuilder()
      .setTitle('wsg im crypto cmmds')
      .setColor('#F0B90B')
      .addFields(
        {
          name: ' Price Tracking',
          value: [
            '`$price <symbol>` — Live price in USD 💵, GBP 💷, PHP 🇵🇭 + 24h change & market cap',
            'Examples: `$price btc` `$price eth` `$price sol` `$price pepe`',
          ].join('\n'),
        },
        {
          name: ' Wallet Tracking',
          value: [
            '`$setaddy <chain> <address>` — Save your wallet address',
            '`$mybal [chain]` — Balances in crypto + USD/GBP/PHP + last 3 transactions',
            '`$bal @user` — See another user\'s saved wallet addresses',
          ].join('\n'),
        },
        {
          name: ' Supported Chains',
          value: [
            '`eth` — Ethereum',
            '`btc` — Bitcoin',
            '`sol` — Solana',
            '`bnb` — BNB Chain',
            '`matic` — Polygon',
            '`avax` — Avalanche',
            '`ltc` — Litecoin',
          ].join('\n'),
        },
        {
          name: ' Examples',
          value: [
            '`$price btc` — Bitcoin price',
            '`$setaddy eth 0xYourAddress` — Save ETH wallet',
            '`$setaddy sol YourSolanaAddress` — Save SOL wallet',
            '`$mybal` — All wallets with fiat value + recent txns',
            '`$mybal ltc` — Just LTC balance',
            '`$ltcalert target 120` — Alert when LTC hits $120',
            '`$ltcalert pct 5` — Alert when LTC moves 5%',
            '`$ltcsubscribe` — Get DM alerts for this server\'s LTC thresholds',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Prices via CoinGecko • Balances via public blockchain APIs' });
    return message.channel.send({ embeds: [embed] });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ Set DISCORD_TOKEN in your environment.'); process.exit(1); }
initDB().then(() => client.login(TOKEN));