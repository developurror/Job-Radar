/** Bot configuration from the environment (upgrade spec §3.2). The token
 *  lives only here and in the Discord login call — it is never logged and
 *  never sent to the JobRadar API. */

export interface BotConfig {
  token: string | null;
  guildId: string | null;
  allowedRoleId: string | null;
  apiBaseUrl: string;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    token: emptyToNull(env.DISCORD_BOT_TOKEN),
    guildId: emptyToNull(env.DISCORD_GUILD_ID),
    allowedRoleId: emptyToNull(env.DISCORD_ALLOWED_ROLE_ID),
    apiBaseUrl: (emptyToNull(env.API_BASE_URL) ?? 'http://api:3001').replace(/\/+$/, ''),
  };
}
