/** Presence (Semy's request, 2026-10-05): when the bot is online it also
 *  advertises what it is for, so server members see "Watching /jobradar
 *  search" under its name in the member list. Presence is account-global
 *  — one bot carries one presence in every server and locale — so there
 *  is deliberately no per-user localization here. Discord flips the bot
 *  to offline by itself when the gateway connection drops; this module
 *  only sets the activity line for while it runs. Presence is garnish,
 *  never load-bearing: a failed setPresence is logged and startup
 *  carries on without it. */
import { ActivityType, type PresenceData } from 'discord.js';

export const PRESENCE_ACTIVITY_NAME = '/jobradar search';

export function buildBotPresence(): PresenceData {
  return {
    status: 'online',
    activities: [{ name: PRESENCE_ACTIVITY_NAME, type: ActivityType.Watching }],
  };
}

/** The slice of the logged-in client user the presence step needs.
 *  ClientUser satisfies it structurally; tests hand in a recording fake. */
export interface PresenceTarget {
  setPresence(presence: PresenceData): unknown;
}

export async function applyBotPresence(presenceTarget: PresenceTarget): Promise<boolean> {
  try {
    await presenceTarget.setPresence(buildBotPresence());
    return true;
  } catch (error) {
    console.warn('Could not set the bot presence activity; continuing without it:', error);
    return false;
  }
}
