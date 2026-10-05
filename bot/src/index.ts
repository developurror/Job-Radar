/** JobRadar Discord bot entrypoint (upgrade spec §3.2).
 *
 * Intents: Guilds only — a slash-command bot needs no privileged intents
 * and never reads message content. Without a DISCORD_BOT_TOKEN the
 * process idles with a clear log line instead of crashing, so the compose
 * stack stays healthy for dashboard-only users. The token is used solely
 * for the Discord login/REST calls below; it is never logged and never
 * sent to the JobRadar API. */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { JobRadarApiClient } from './apiClient.js';
import { resolveBotLocale, translate } from './catalog.js';
import { loadBotConfig, type BotConfig } from './config.js';
import { applyBotPresence } from './presence.js';
import {
  handleForgetCommand,
  handleHelpCommand,
  handleSearchCommand,
  type SessionFlowDeps,
} from './sessionFlow.js';

export function buildJobRadarCommand(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName('jobradar')
    .setDescription(translate('en', 'commandDescription'))
    .setDescriptionLocalizations({ fr: translate('fr', 'commandDescription') })
    .addSubcommand((searchSubcommand) =>
      searchSubcommand
        .setName('search')
        .setDescription(translate('en', 'searchSubcommandDescription'))
        .setDescriptionLocalizations({ fr: translate('fr', 'searchSubcommandDescription') })
        .addStringOption((queryOption) =>
          queryOption
            .setName('query')
            .setDescription(translate('en', 'searchQueryOptionDescription'))
            .setDescriptionLocalizations({ fr: translate('fr', 'searchQueryOptionDescription') })
            .setRequired(false),
        ),
    )
    .addSubcommand((forgetSubcommand) =>
      forgetSubcommand
        .setName('forget')
        .setDescription(translate('en', 'forgetSubcommandDescription'))
        .setDescriptionLocalizations({ fr: translate('fr', 'forgetSubcommandDescription') }),
    )
    .addSubcommand((helpSubcommand) =>
      helpSubcommand
        .setName('help')
        .setDescription(translate('en', 'helpSubcommandDescription'))
        .setDescriptionLocalizations({ fr: translate('fr', 'helpSubcommandDescription') }),
    );
}

async function registerCommands(config: BotConfig, applicationId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token as string);
  const commandBody = [buildJobRadarCommand().toJSON()];
  if (config.guildId !== null) {
    // Guild commands propagate instantly.
    await rest.put(Routes.applicationGuildCommands(applicationId, config.guildId), {
      body: commandBody,
    });
    console.log(`Registered /jobradar commands in guild ${config.guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(applicationId), { body: commandBody });
    console.log('Registered /jobradar commands globally (propagation can take up to an hour).');
  }
}

function idleForever(logLine: string): void {
  console.log(logLine);
  setInterval(() => {}, 1 << 30);
}

async function main(): Promise<void> {
  const config = loadBotConfig();
  if (config.token === null) {
    idleForever(
      'DISCORD_BOT_TOKEN not set, idling — the dashboard works without the bot. ' +
        'Set DISCORD_BOT_TOKEN (and DISCORD_GUILD_ID) in .env to enable the Discord bot.',
    );
    return;
  }

  const flowDeps: SessionFlowDeps = {
    apiClient: new JobRadarApiClient(config.apiBaseUrl),
    configuredGuildId: config.guildId,
    allowedRoleId: config.allowedRoleId,
  };
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`JobRadar bot logged in as ${readyClient.user.tag}.`);
    try {
      await registerCommands(config, readyClient.application.id);
    } catch (error) {
      console.error('Failed to register /jobradar commands:', error);
    }
    await applyBotPresence(readyClient.user);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'jobradar') return;
    try {
      const subcommandName = interaction.options.getSubcommand();
      if (subcommandName === 'search') await handleSearchCommand(interaction, flowDeps);
      else if (subcommandName === 'forget') await handleForgetCommand(interaction, flowDeps);
      else if (subcommandName === 'help') await handleHelpCommand(interaction, flowDeps);
    } catch (error) {
      console.error('JobRadar interaction failed:', error);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: translate(resolveBotLocale(interaction.locale), 'errorGeneric'),
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // The interaction is already gone; the log line above is the record.
      }
    }
  });

  try {
    await client.login(config.token);
  } catch (error) {
    console.error('Discord login failed (check DISCORD_BOT_TOKEN):', error);
    idleForever('JobRadar bot idling after a failed Discord login.');
  }
}

void main();
