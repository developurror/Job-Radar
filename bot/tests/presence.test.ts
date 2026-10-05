import { ActivityType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { applyBotPresence, buildBotPresence, type PresenceTarget } from '../src/presence.js';

describe('buildBotPresence', () => {
  it('is online with a single Watching activity naming the search command', () => {
    const presence = buildBotPresence();

    expect(presence.status).toBe('online');
    expect(presence.activities).toHaveLength(1);
    expect(presence.activities?.[0]?.name).toBe('/jobradar search');
    expect(presence.activities?.[0]?.type).toBe(ActivityType.Watching);
  });
});

describe('applyBotPresence', () => {
  it('hands the built presence to the target and reports success', async () => {
    const recordedPayloads: unknown[] = [];
    const recordingTarget: PresenceTarget = {
      setPresence(presence) {
        recordedPayloads.push(presence);
      },
    };

    await expect(applyBotPresence(recordingTarget)).resolves.toBe(true);
    expect(recordedPayloads).toEqual([buildBotPresence()]);
  });

  it('swallows a rejected setPresence, warns, and reports failure', async () => {
    const failingTarget: PresenceTarget = {
      setPresence() {
        throw new Error('gateway said no');
      },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(applyBotPresence(failingTarget)).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
