import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, MessageComponentInteraction } from 'discord.js';
import type { JobRadarApiClient } from '../src/apiClient.js';
import { handleSearchCommand, type SessionFlowDeps } from '../src/sessionFlow.js';

/** Minimal stand-in for discord.js' MessageComponentCollector: production
 *  only uses .on('collect'), .once('end') and .stop(reason), and stop is
 *  what emits 'end' (with the reason) in the real collector too. */
class FakeComponentCollector extends EventEmitter {
  stop(reason = 'stopped'): void {
    this.emit('end', new Map(), reason);
  }
}

describe('filter round message edits', () => {
  it('re-renders the filter message through editReply after the skills modal, never through Message.edit', async () => {
    const collector = new FakeComponentCollector();
    // Message.edit() is the channel-messages route: Discord answers 10008
    // Unknown Message for ephemeral messages. It must never be called.
    const channelRouteEdit = vi.fn(async () => {
      throw new Error('Unknown Message (10008)');
    });
    const filterMessage = {
      id: 'filter-message-1',
      edit: channelRouteEdit,
      createMessageComponentCollector: vi.fn(() => collector),
    };
    const modalSubmit = {
      customId: 'jobradar-search-modal',
      user: { id: 'user-1' },
      fields: {
        getTextInputValue: (customId: string) => (customId === 'keywords' ? 'developer' : ''),
      },
      reply: vi.fn(async () => filterMessage),
      fetchReply: vi.fn(async () => filterMessage),
      editReply: vi.fn(async () => filterMessage),
    };
    const commandInteraction = {
      guildId: 'guild-1',
      locale: 'en-US',
      user: { id: 'user-1' },
      member: null,
      options: { getString: () => 'developer' },
      showModal: vi.fn(async () => {}),
      awaitModalSubmit: vi.fn(async () => modalSubmit),
    };
    const apiClient = {
      getRememberedProfile: vi.fn(async () => null),
      saveRememberedProfile: vi.fn(async () => {}),
      runIngestion: vi.fn(async () => {}),
      createSession: vi.fn(async () => ({ sessionId: 7, alreadyRunning: false })),
      getSession: vi.fn(async () => ({ status: 'done', results: [] })),
      forgetRememberedProfile: vi.fn(async () => true),
    };
    const deps: SessionFlowDeps = {
      apiClient: apiClient as unknown as JobRadarApiClient,
      configuredGuildId: 'guild-1',
      allowedRoleId: null,
    };

    const flowPromise = handleSearchCommand(
      commandInteraction as unknown as ChatInputCommandInteraction,
      deps,
    );
    await vi.waitFor(() => {
      expect(collector.listeners('collect')).toHaveLength(1);
    });
    const collectHandler = collector.listeners('collect')[0] as (
      component: MessageComponentInteraction,
    ) => Promise<void>;

    // The exact step that died live: open the Key skills modal from the
    // filter round, submit two skills, and the round re-renders itself.
    const skillsSubmit = {
      customId: 'jobradar-skills-modal',
      user: { id: 'user-1' },
      fields: { getTextInputValue: () => 'javascript, php' },
      deferUpdate: vi.fn(async () => {}),
    };
    const skillsButton = {
      user: { id: 'user-1' },
      customId: 'filter-skills',
      isStringSelectMenu: () => false,
      isButton: () => true,
      showModal: vi.fn(async () => {}),
      awaitModalSubmit: vi.fn(async () => skillsSubmit),
      deferUpdate: vi.fn(async () => {}),
    };
    await collectHandler(skillsButton as unknown as MessageComponentInteraction);

    expect(modalSubmit.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Key skills: javascript, php'),
      }),
    );
    expect(channelRouteEdit).not.toHaveBeenCalled();

    // Cancel ends the round; its cleanup edit takes the same route.
    const cancelButton = {
      user: { id: 'user-1' },
      customId: 'filter-cancel',
      isStringSelectMenu: () => false,
      isButton: () => true,
      deferUpdate: vi.fn(async () => {}),
    };
    await collectHandler(cancelButton as unknown as MessageComponentInteraction);
    await flowPromise;

    expect(modalSubmit.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('cancelled') }),
    );
    expect(channelRouteEdit).not.toHaveBeenCalled();
  });
});
