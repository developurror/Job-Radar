import { describe, expect, it } from 'vitest';
import { accessDenial, memberRoleIds } from '../src/accessControl.js';

describe('memberRoleIds', () => {
  it('reads the raw interaction member shape (roles as a string array)', () => {
    expect(memberRoleIds({ roles: ['role-1', 'role-2'] })).toEqual(['role-1', 'role-2']);
  });

  it('reads the GuildMember shape (roles manager with a cache map)', () => {
    const guildMemberShape = { roles: { cache: new Map([['role-9', {}], ['role-7', {}]]) } };
    expect(memberRoleIds(guildMemberShape).sort()).toEqual(['role-7', 'role-9']);
  });

  it('returns no roles for missing or malformed members', () => {
    expect(memberRoleIds(null)).toEqual([]);
    expect(memberRoleIds(undefined)).toEqual([]);
    expect(memberRoleIds({})).toEqual([]);
    expect(memberRoleIds({ roles: 'not-an-array' })).toEqual([]);
  });
});

describe('accessDenial', () => {
  const baseOptions = {
    guildId: 'guild-1',
    configuredGuildId: 'guild-1',
    roleIds: [] as string[],
    allowedRoleId: null,
  };

  it('allows everything when no guild or role is configured', () => {
    expect(accessDenial({ ...baseOptions, configuredGuildId: null })).toBeNull();
    expect(accessDenial({ ...baseOptions, guildId: null, configuredGuildId: null })).toBeNull();
  });

  it('denies in a different guild than the configured one', () => {
    expect(accessDenial({ ...baseOptions, guildId: 'guild-2' })).toBe('wrong-guild');
  });

  it('denies guild members without the allowed role, allows holders', () => {
    const gatedOptions = { ...baseOptions, allowedRoleId: 'role-jobradar' };
    expect(accessDenial({ ...gatedOptions, roleIds: ['role-other'] })).toBe('role-required');
    expect(accessDenial({ ...gatedOptions, roleIds: ['role-jobradar'] })).toBeNull();
  });

  it('allows DMs (no guild to check, no roles to verify)', () => {
    expect(
      accessDenial({ ...baseOptions, guildId: null, allowedRoleId: 'role-jobradar' }),
    ).toBeNull();
  });

  it('treats an unset allowed role as the whole guild being welcome', () => {
    expect(accessDenial({ ...baseOptions, roleIds: [] })).toBeNull();
  });
});
