/** Guild + role gating (upgrade spec §3.2, decision 2026-10-05): the bot
 *  answers only in its configured guild, and — when DISCORD_ALLOWED_ROLE_ID
 *  is set — only for members holding that role. Pure functions over the
 *  interaction's member payload, so they are unit-testable without a
 *  gateway connection. DMs carry no guild/member roles to check; they are
 *  allowed (the spec's flow supports DMs from guild members). */

export type AccessDenial = 'wrong-guild' | 'role-required';

/** Extract role ids from either member shape discord.js can hand us: the
 *  raw interaction member (roles is a string array) or a GuildMember
 *  (roles is a manager with a cache map). */
export function memberRoleIds(member: unknown): string[] {
  if (member === null || typeof member !== 'object') return [];
  const roles = (member as { roles?: unknown }).roles;
  if (Array.isArray(roles)) {
    return roles.filter((roleId): roleId is string => typeof roleId === 'string');
  }
  if (roles !== null && typeof roles === 'object' && 'cache' in roles) {
    const cache = (roles as { cache?: unknown }).cache;
    if (cache instanceof Map) {
      return [...cache.keys()].filter((roleId): roleId is string => typeof roleId === 'string');
    }
  }
  return [];
}

export function accessDenial(options: {
  guildId: string | null;
  configuredGuildId: string | null;
  roleIds: string[];
  allowedRoleId: string | null;
}): AccessDenial | null {
  if (
    options.configuredGuildId !== null &&
    options.guildId !== null &&
    options.guildId !== options.configuredGuildId
  ) {
    return 'wrong-guild';
  }
  if (
    options.guildId !== null &&
    options.allowedRoleId !== null &&
    !options.roleIds.includes(options.allowedRoleId)
  ) {
    return 'role-required';
  }
  return null;
}
