/** The /jobradar conversation flow (upgrade spec §3.3): slash command →
 *  modal (first response — Discord requires it) → ephemeral filter round
 *  with select menus → ingestion → API session → progress edits at stage
 *  changes only → result embeds with paging. All durable state lives in
 *  the API (remembered answers + the session row); this module keeps only
 *  the in-flight answers of one interaction. */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ApiRequestError, type JobRadarApiClient } from './apiClient.js';
import type {
  BotFilterInput,
  BotSearchInput,
  BotSessionResult,
  BotSessionStatus,
  BotSessionView,
  BotUserProfile,
} from './apiTypes.js';
import { accessDenial, memberRoleIds } from './accessControl.js';
import { resolveBotLocale, translate, type BotLocale, type BotStringKey } from './catalog.js';
import { buildResultsPage } from './embeds.js';
import {
  EXPERIENCE_OPTIONS,
  SALARY_FLOOR_OPTIONS,
  buildSessionRequest,
  defaultFilterInput,
  emptySearchInput,
  salaryFloorFromSelectValue,
  selectValueForSalaryFloor,
  selectValueForStaffing,
  selectValueForWorkMode,
  selectValueForYearsExperience,
  staffingAcceptableFromSelectValue,
  workModeFromSelectValue,
  yearsExperienceFromSelectValue,
} from './payloadMapping.js';

const SEARCH_MODAL_ID = 'jobradar-search-modal';
const SKILLS_MODAL_ID = 'jobradar-skills-modal';
const WORK_MODE_SELECT_ID = 'filter-work-mode';
const SALARY_SELECT_ID = 'filter-salary';
const EXPERIENCE_SELECT_ID = 'filter-experience';
const STAFFING_SELECT_ID = 'filter-staffing';
const SKILLS_BUTTON_ID = 'filter-skills';
const START_BUTTON_ID = 'filter-start';
const CANCEL_BUTTON_ID = 'filter-cancel';
const MORE_RESULTS_BUTTON_ID = 'results-more';

const MODAL_TIMEOUT_MS = 5 * 60 * 1000;
const FILTER_ROUND_TIMEOUT_MS = 10 * 60 * 1000;
const RESULTS_PAGING_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_POLL_INTERVAL_MS = 3000;
/** The interaction token lives 15 minutes; stop polling shy of that so the
 *  final edit (or the channel fallback) still has room to happen. */
const SESSION_POLL_DEADLINE_MS = 14 * 60 * 1000;

export interface SessionFlowDeps {
  apiClient: JobRadarApiClient;
  configuredGuildId: string | null;
  allowedRoleId: string | null;
}

interface FlowContext {
  userId: string;
  locale: BotLocale;
  search: BotSearchInput;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checkAccess(
  interaction: ChatInputCommandInteraction,
  deps: SessionFlowDeps,
  locale: BotLocale,
): Promise<boolean> {
  const denial = accessDenial({
    guildId: interaction.guildId,
    configuredGuildId: deps.configuredGuildId,
    roleIds: memberRoleIds(interaction.member),
    allowedRoleId: deps.allowedRoleId,
  });
  if (denial === null) return true;
  await interaction.reply({
    content: translate(locale, denial === 'wrong-guild' ? 'wrongGuild' : 'roleRequired'),
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

function textInputOrNull(submit: ModalSubmitInteraction, customId: string): string | null {
  const value = submit.fields.getTextInputValue(customId).trim();
  return value === '' ? null : value;
}

function buildSearchModal(locale: BotLocale, search: BotSearchInput): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(SEARCH_MODAL_ID)
    .setTitle(translate(locale, 'modalTitle'));
  const addTextInput = (
    customId: string,
    labelKey: BotStringKey,
    options: { required?: boolean; placeholderKey?: BotStringKey; value: string | null },
  ) => {
    const input = new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(translate(locale, labelKey))
      .setStyle(TextInputStyle.Short)
      .setRequired(options.required ?? false);
    if (options.placeholderKey) input.setPlaceholder(translate(locale, options.placeholderKey));
    if (options.value !== null && options.value !== '') input.setValue(options.value);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  };
  addTextInput('keywords', 'keywordsLabel', {
    required: true,
    placeholderKey: 'keywordsPlaceholder',
    value: search.keywords,
  });
  addTextInput('city', 'cityLabel', { value: search.city });
  addTextInput('province', 'provinceLabel', { value: search.provinceState });
  addTextInput('country', 'countryLabel', { value: search.country });
  addTextInput('domain', 'domainLabel', { value: search.field });
  return modal;
}

function buildSkillsModal(locale: BotLocale, skillsText: string | null): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId('skills')
    .setLabel(translate(locale, 'skillsFieldLabel'))
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder(translate(locale, 'skillsPlaceholder'));
  if (skillsText !== null && skillsText !== '') input.setValue(skillsText);
  return new ModalBuilder()
    .setCustomId(SKILLS_MODAL_ID)
    .setTitle(translate(locale, 'skillsModalTitle'))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

const EXPERIENCE_LABEL_KEYS: Record<string, BotStringKey> = {
  any: 'experienceAny',
  '0-2': 'experience0to2',
  '3-5': 'experience3to5',
  '6-9': 'experience6to9',
  '10+': 'experience10plus',
};

const WORK_MODE_LABEL_KEYS: Record<string, BotStringKey> = {
  any: 'workModeAny',
  remote: 'workModeRemote',
  hybrid: 'workModeHybrid',
  onsite: 'workModeOnsite',
};

function buildSelectRow(
  customId: string,
  placeholder: string,
  selectOptions: { value: string; label: string }[],
  selectedValue: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      selectOptions.map((selectOption) => ({
        label: selectOption.label,
        value: selectOption.value,
        default: selectOption.value === selectedValue,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildFilterComponents(
  locale: BotLocale,
  filters: BotFilterInput,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const workModeRow = buildSelectRow(
    WORK_MODE_SELECT_ID,
    translate(locale, 'workModeLabel'),
    Object.entries(WORK_MODE_LABEL_KEYS).map(([selectValue, labelKey]) => ({
      value: selectValue,
      label: translate(locale, labelKey),
    })),
    selectValueForWorkMode(filters.workMode),
  );
  const salaryRow = buildSelectRow(
    SALARY_SELECT_ID,
    translate(locale, 'salaryLabel'),
    SALARY_FLOOR_OPTIONS.map((salaryOption) => ({
      value: salaryOption.selectValue,
      label:
        salaryOption.floor === null
          ? translate(locale, 'salaryAny')
          : `${salaryOption.floor / 1000}k+`,
    })),
    selectValueForSalaryFloor(filters.salaryFloor),
  );
  const experienceRow = buildSelectRow(
    EXPERIENCE_SELECT_ID,
    translate(locale, 'experienceLabel'),
    EXPERIENCE_OPTIONS.map((experienceOption) => ({
      value: experienceOption.selectValue,
      label: translate(locale, EXPERIENCE_LABEL_KEYS[experienceOption.selectValue] ?? 'experienceAny'),
    })),
    selectValueForYearsExperience(filters.yearsExperience),
  );
  const staffingRow = buildSelectRow(
    STAFFING_SELECT_ID,
    translate(locale, 'staffingLabel'),
    [
      { value: 'acceptable', label: translate(locale, 'staffingAcceptable') },
      { value: 'exclude', label: translate(locale, 'staffingExclude') },
    ],
    selectValueForStaffing(filters.staffingAcceptable),
  );
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SKILLS_BUTTON_ID)
      .setLabel(translate(locale, 'skillsButton'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(START_BUTTON_ID)
      .setLabel(translate(locale, 'startButton'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CANCEL_BUTTON_ID)
      .setLabel(translate(locale, 'cancelButton'))
      .setStyle(ButtonStyle.Danger),
  );
  return [workModeRow, salaryRow, experienceRow, staffingRow, buttonRow];
}

function buildFilterContent(
  locale: BotLocale,
  filters: BotFilterInput,
  hadRememberedAnswers: boolean,
): string {
  const contentLines = [translate(locale, 'filtersPrompt')];
  if (hadRememberedAnswers) contentLines.push(translate(locale, 'savedAnswersNote'));
  if (filters.skillsText !== null) {
    contentLines.push(
      translate(locale, 'skillsSetNote', { skills: filters.skillsText.slice(0, 300) }),
    );
  }
  return contentLines.join('\n');
}

function stageTextForStatus(status: BotSessionStatus, locale: BotLocale): string {
  switch (status) {
    case 'evaluating':
      return translate(locale, 'stageEvaluating');
    case 'scoring':
      return translate(locale, 'stageScoring');
    case 'researching':
      return translate(locale, 'stageResearching');
    default:
      return translate(locale, 'searchingWeb');
  }
}

async function showFlowError(message: Message, locale: BotLocale, error: unknown): Promise<void> {
  const content =
    error instanceof ApiRequestError && error.status === null
      ? translate(locale, 'errorApiUnreachable')
      : translate(locale, 'errorGeneric');
  await message.edit({ content, components: [], embeds: [] }).catch(() => {});
}

async function runFilterRound(
  modalSubmit: ModalSubmitInteraction,
  deps: SessionFlowDeps,
  context: FlowContext & {
    initialFilters: BotFilterInput;
    hadRememberedAnswers: boolean;
  },
): Promise<void> {
  const filters: BotFilterInput = { ...context.initialFilters };
  await modalSubmit.reply({
    content: buildFilterContent(context.locale, filters, context.hadRememberedAnswers),
    components: buildFilterComponents(context.locale, filters),
    flags: MessageFlags.Ephemeral,
  });
  const filterMessage = await modalSubmit.fetchReply();

  const collector = filterMessage.createMessageComponentCollector({
    filter: (component) => component.user.id === context.userId,
    time: FILTER_ROUND_TIMEOUT_MS,
  });

  let startRequested = false;
  collector.on('collect', async (component) => {
    try {
      if (component.isStringSelectMenu()) {
        const selectedValue = component.values[0] ?? '';
        if (component.customId === WORK_MODE_SELECT_ID) {
          filters.workMode = workModeFromSelectValue(selectedValue);
        } else if (component.customId === SALARY_SELECT_ID) {
          filters.salaryFloor = salaryFloorFromSelectValue(selectedValue);
        } else if (component.customId === EXPERIENCE_SELECT_ID) {
          filters.yearsExperience = yearsExperienceFromSelectValue(selectedValue);
        } else if (component.customId === STAFFING_SELECT_ID) {
          filters.staffingAcceptable = staffingAcceptableFromSelectValue(selectedValue);
        }
        await component.deferUpdate();
      } else if (component.isButton() && component.customId === SKILLS_BUTTON_ID) {
        await component.showModal(buildSkillsModal(context.locale, filters.skillsText));
        const skillsSubmit = await component
          .awaitModalSubmit({
            filter: (submit) =>
              submit.customId === SKILLS_MODAL_ID && submit.user.id === context.userId,
            time: MODAL_TIMEOUT_MS,
          })
          .catch(() => null);
        if (skillsSubmit !== null) {
          const skillsValue = skillsSubmit.fields.getTextInputValue('skills').trim();
          filters.skillsText = skillsValue === '' ? null : skillsValue;
          await skillsSubmit.deferUpdate();
          await filterMessage.edit({
            content: buildFilterContent(context.locale, filters, context.hadRememberedAnswers),
            components: buildFilterComponents(context.locale, filters),
          });
        }
      } else if (component.isButton() && component.customId === START_BUTTON_ID) {
        startRequested = true;
        await component.deferUpdate();
        collector.stop('start');
      } else if (component.isButton() && component.customId === CANCEL_BUTTON_ID) {
        await component.deferUpdate();
        collector.stop('cancel');
      }
    } catch (error) {
      console.error('JobRadar filter round interaction failed:', error);
    }
  });

  const endReason = await new Promise<string>((resolve) => {
    collector.once('end', (_collectedComponents, reason) => resolve(reason));
  });

  if (!startRequested) {
    try {
      if (endReason === 'cancel') {
        await filterMessage.edit({
          content: translate(context.locale, 'cancelled'),
          components: [],
        });
      } else {
        await filterMessage.edit({ components: [] });
      }
    } catch {
      // The interaction token may already be gone; nothing to clean up.
    }
    return;
  }

  await runSearchAndShowResults(modalSubmit, filterMessage, deps, { ...context, filters });
}

async function runSearchAndShowResults(
  modalSubmit: ModalSubmitInteraction,
  filterMessage: Message,
  deps: SessionFlowDeps,
  context: FlowContext & { filters: BotFilterInput },
): Promise<void> {
  const { locale } = context;
  try {
    await filterMessage.edit({
      content: translate(locale, 'searchingWeb'),
      components: [],
      embeds: [],
    });
    await deps.apiClient.runIngestion(context.search);
  } catch (error) {
    await showFlowError(filterMessage, locale, error);
    return;
  }

  let sessionInfo: { sessionId: number; alreadyRunning: boolean };
  try {
    sessionInfo = await deps.apiClient.createSession(
      buildSessionRequest(context.userId, context.search, context.filters),
    );
  } catch (error) {
    await showFlowError(filterMessage, locale, error);
    return;
  }
  // Remembered answers are a convenience; a failed save never fails the run.
  await deps.apiClient
    .saveRememberedProfile(context.userId, context.search, context.filters, locale)
    .catch(() => {});

  let lastStageText = '';
  if (sessionInfo.alreadyRunning) {
    lastStageText = translate(locale, 'alreadyRunning');
    await filterMessage.edit({ content: lastStageText }).catch(() => {});
  }

  let finalView: BotSessionView | null = null;
  const deadline = Date.now() + SESSION_POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    let view: BotSessionView;
    try {
      view = await deps.apiClient.getSession(sessionInfo.sessionId);
    } catch (error) {
      await showFlowError(filterMessage, locale, error);
      return;
    }
    if (view.status === 'done' || view.status === 'failed') {
      finalView = view;
      break;
    }
    const stageText = stageTextForStatus(view.status, locale);
    if (stageText !== lastStageText) {
      lastStageText = stageText;
      await filterMessage.edit({ content: stageText }).catch(() => {});
    }
    await sleep(SESSION_POLL_INTERVAL_MS);
  }
  if (finalView === null) {
    try {
      const lastView = await deps.apiClient.getSession(sessionInfo.sessionId);
      if (lastView.status === 'done' || lastView.status === 'failed') finalView = lastView;
    } catch {
      // finalView stays null; handled below.
    }
  }
  if (finalView === null || finalView.status === 'failed') {
    await filterMessage
      .edit({ content: translate(locale, 'errorGeneric'), components: [], embeds: [] })
      .catch(() => {});
    return;
  }

  const results = finalView.results ?? [];
  if (results.length === 0) {
    await filterMessage
      .edit({ content: translate(locale, 'resultsEmpty'), components: [], embeds: [] })
      .catch(() => {});
    return;
  }
  await showResultsPages(modalSubmit, filterMessage, context, sessionInfo.sessionId, results);
}

async function showResultsPages(
  modalSubmit: ModalSubmitInteraction,
  filterMessage: Message,
  context: FlowContext,
  sessionId: number,
  results: BotSessionResult[],
): Promise<void> {
  const { locale } = context;
  const renderPage = async (page: number) => {
    const builtPage = buildResultsPage(results, page, locale);
    const headerLines = [
      translate(locale, 'resultsTitle') +
        (context.search.keywords !== null ? ` — ${context.search.keywords}` : ''),
    ];
    if (builtPage.pageCount > 1) {
      headerLines.push(
        translate(locale, 'pageLabel', { page: builtPage.page + 1, pageCount: builtPage.pageCount }),
      );
    }
    const hasNextPage = builtPage.page < builtPage.pageCount - 1;
    await filterMessage.edit({
      content: headerLines.join('\n'),
      embeds: builtPage.embeds,
      components: hasNextPage
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(MORE_RESULTS_BUTTON_ID)
                .setLabel(translate(locale, 'moreButton'))
                .setStyle(ButtonStyle.Secondary),
            ),
          ]
        : [],
    });
    return builtPage;
  };

  let firstPage;
  try {
    firstPage = await renderPage(0);
  } catch {
    // The interaction token expired (15 minutes): post the results as a
    // fresh channel message mentioning the user, keyed by session id
    // (spec §3.3 step 8 — designed-for, not an error).
    const fallbackPage = buildResultsPage(results, 0, locale);
    const channel = modalSubmit.channel;
    if (channel !== null && 'send' in channel) {
      await channel
        .send({
          content: translate(locale, 'channelFallback', {
            mention: `<@${context.userId}>`,
            sessionId,
          }),
          embeds: fallbackPage.embeds,
        })
        .catch(() => {});
    }
    return;
  }
  if (firstPage.pageCount <= 1) return;

  let currentPage = 0;
  const pagingCollector = filterMessage.createMessageComponentCollector({
    filter: (component) =>
      component.user.id === context.userId && component.customId === MORE_RESULTS_BUTTON_ID,
    time: RESULTS_PAGING_TIMEOUT_MS,
  });
  pagingCollector.on('collect', async (component) => {
    try {
      await component.deferUpdate();
      const builtPage = await renderPage(currentPage + 1);
      currentPage = builtPage.page;
      if (currentPage >= firstPage.pageCount - 1) pagingCollector.stop('last-page');
    } catch {
      pagingCollector.stop('edit-failed');
    }
  });
}

export async function handleSearchCommand(
  interaction: ChatInputCommandInteraction,
  deps: SessionFlowDeps,
): Promise<void> {
  const locale = resolveBotLocale(interaction.locale);
  if (!(await checkAccess(interaction, deps, locale))) return;
  const userId = interaction.user.id;

  let remembered: BotUserProfile | null = null;
  try {
    remembered = await deps.apiClient.getRememberedProfile(userId);
  } catch {
    remembered = null;
  }
  const initialSearch: BotSearchInput = remembered
    ? { ...remembered.search }
    : { ...emptySearchInput() };
  const queryText = interaction.options.getString('query')?.trim() ?? '';
  if (queryText !== '') initialSearch.keywords = queryText;
  const initialFilters: BotFilterInput = remembered
    ? { ...remembered.filters }
    : defaultFilterInput();

  // The modal must be the first response to the slash command.
  await interaction.showModal(buildSearchModal(locale, initialSearch));
  const modalSubmit = await interaction
    .awaitModalSubmit({
      filter: (submit) => submit.customId === SEARCH_MODAL_ID && submit.user.id === userId,
      time: MODAL_TIMEOUT_MS,
    })
    .catch(() => null);
  if (modalSubmit === null) return; // modal timed out; nothing was sent yet

  const search: BotSearchInput = {
    keywords: textInputOrNull(modalSubmit, 'keywords'),
    city: textInputOrNull(modalSubmit, 'city'),
    provinceState: textInputOrNull(modalSubmit, 'province'),
    country: textInputOrNull(modalSubmit, 'country'),
    field: textInputOrNull(modalSubmit, 'domain'),
    enabledSources: initialSearch.enabledSources,
  };
  // Session state lives in the API from the first answers on (spec §3.3).
  await deps.apiClient
    .saveRememberedProfile(userId, search, initialFilters, locale)
    .catch(() => {});

  await runFilterRound(modalSubmit, deps, {
    userId,
    locale,
    search,
    initialFilters,
    hadRememberedAnswers: remembered !== null,
  });
}

export async function handleForgetCommand(
  interaction: ChatInputCommandInteraction,
  deps: SessionFlowDeps,
): Promise<void> {
  const locale = resolveBotLocale(interaction.locale);
  if (!(await checkAccess(interaction, deps, locale))) return;
  let forgotten = false;
  try {
    forgotten = await deps.apiClient.forgetRememberedProfile(interaction.user.id);
  } catch {
    await interaction.reply({
      content: translate(locale, 'errorGeneric'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: translate(locale, forgotten ? 'forgetDone' : 'forgetNothing'),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
  deps: SessionFlowDeps,
): Promise<void> {
  const locale = resolveBotLocale(interaction.locale);
  if (!(await checkAccess(interaction, deps, locale))) return;
  await interaction.reply({
    content: translate(locale, 'helpText'),
    flags: MessageFlags.Ephemeral,
  });
}
