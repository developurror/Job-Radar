/** The bot's own string catalog (upgrade spec §3.3): only the bot's chrome
 *  is localized — questions, menu labels, score labels, footer — chosen by
 *  the locale Discord reports for each interaction, fallback English.
 *  Result content (postings, evidence, intel) is shown as-is, exactly like
 *  the dashboard (spec §2.2). Key parity between locales is test-enforced. */

export const BOT_LOCALES = ['en', 'fr'] as const;
export type BotLocale = (typeof BOT_LOCALES)[number];

const enStrings = {
  commandDescription: 'Search jobs with JobRadar',
  searchSubcommandDescription: 'Run a job search and get the top matches',
  searchQueryOptionDescription: 'What are you looking for? e.g. "typescript developer montreal"',
  forgetSubcommandDescription: 'Forget my saved JobRadar answers',
  helpSubcommandDescription: 'How JobRadar on Discord works',
  modalTitle: 'JobRadar search',
  keywordsLabel: 'Job title or keywords',
  keywordsPlaceholder: 'e.g. typescript developer',
  cityLabel: 'City (optional)',
  provinceLabel: 'Province / state (optional)',
  countryLabel: 'Country code (optional)',
  countryPlaceholder: 'Use the country code: ex. us, ca',
  domainLabel: 'Domain / field (optional)',
  filtersPrompt: 'Tune your search below, then press Start search.',
  savedAnswersNote: 'Using your saved answers — /jobradar forget clears them.',
  skillsSetNote: 'Key skills: {skills}',
  workModeLabel: 'Work mode',
  workModeAny: 'Any work mode',
  workModeRemote: 'Remote',
  workModeHybrid: 'Hybrid or remote',
  workModeOnsite: 'On-site',
  salaryLabel: 'Minimum salary',
  salaryAny: 'Any salary',
  experienceLabel: 'Your experience',
  experienceAny: 'Any experience level',
  experience0to2: '0–2 years',
  experience3to5: '3–5 years',
  experience6to9: '6–9 years',
  experience10plus: '10+ years',
  staffingLabel: 'Staffing companies',
  staffingAcceptable: 'Acceptable — keep the jobs, show the flag',
  staffingExclude: 'Exclude jobs posted via staffing companies',
  skillsButton: 'Set key skills',
  skillsModalTitle: 'Your key skills',
  skillsFieldLabel: 'Key skills (comma separated)',
  skillsPlaceholder: 'e.g. TypeScript, Node.js, Vue',
  startButton: 'Start search',
  cancelButton: 'Cancel',
  cancelled: 'Search cancelled.',
  searchingWeb: 'Searching the web for fresh postings…',
  stageEvaluating: 'Evaluating the job pool against your answers…',
  stageScoring: 'Scoring the jobs that passed…',
  stageResearching: 'Researching company intel for the top results…',
  alreadyRunning: 'A search is already running for you — here is its progress.',
  resultsTitle: 'Top matches',
  resultsEmpty:
    'No jobs passed your filters this time. Try a wider work mode, a lower salary floor, or different keywords.',
  moreButton: 'More results',
  pageLabel: 'Page {page} of {pageCount}',
  scoreOverall: 'Overall',
  scoreInterviewChance: 'Interview chance',
  scoreQuality: 'Quality',
  intelPending: 'Intel: still researching — the finished report lands in the dashboard.',
  intelLabel: 'Intel',
  viewPosting: 'View posting',
  footer: 'Scores by JobRadar · full details in the dashboard',
  channelFallback:
    '{mention} your JobRadar results are ready — the reply window expired, so here they are. Session #{sessionId}',
  errorGeneric:
    'Something went wrong running that search. The dashboard still works — please try again in a moment.',
  errorApiUnreachable: "JobRadar's API is not answering right now. Is the stack running?",
  roleRequired:
    'This command is limited to members holding the JobRadar role on this server — ask the server owner.',
  wrongGuild: 'JobRadar only answers on its configured server.',
  forgetDone: 'Done — your saved JobRadar answers are forgotten. The next search starts from scratch.',
  forgetNothing: 'You had no saved JobRadar answers — nothing to forget.',
  helpText:
    '**JobRadar on Discord**\nRun `/jobradar search`, answer what you are looking for, then tune the filters (work mode, salary floor, experience, staffing companies). JobRadar searches its sources, scores the matches against your answers, researches the top companies, and posts your best results right here — **More results** pages further.\nYour answers are remembered on the JobRadar machine so the next search starts pre-filled; `/jobradar forget` wipes them. Full score breakdowns live in the dashboard.\nNote: what you type to the bot passes through Discord’s servers, like any Discord message. In DMs there are no ephemeral (only-you) messages, so answers show in the DM itself.',
};

export type BotStringKey = keyof typeof enStrings;
export type BotStrings = Record<BotStringKey, string>;

const frStrings: BotStrings = {
  commandDescription: 'Rechercher des emplois avec JobRadar',
  searchSubcommandDescription: 'Lancer une recherche et recevoir les meilleurs résultats',
  searchQueryOptionDescription: 'Que cherchez-vous ? ex. « développeur typescript montréal »',
  forgetSubcommandDescription: 'Effacer mes réponses JobRadar enregistrées',
  helpSubcommandDescription: 'Comment fonctionne JobRadar sur Discord',
  modalTitle: 'Recherche JobRadar',
  keywordsLabel: 'Titre du poste ou mots-clés',
  keywordsPlaceholder: 'ex. développeur typescript',
  cityLabel: 'Ville (optionnel)',
  provinceLabel: 'Province / état (optionnel)',
  countryLabel: 'Code de pays (optionnel)',
  countryPlaceholder: 'Utilisez le code du pays : ex. us, ca',
  domainLabel: 'Domaine (optionnel)',
  filtersPrompt: 'Ajustez votre recherche ci-dessous, puis appuyez sur Lancer la recherche.',
  savedAnswersNote: 'Vos réponses enregistrées sont utilisées — /jobradar forget les efface.',
  skillsSetNote: 'Compétences clés : {skills}',
  workModeLabel: 'Mode de travail',
  workModeAny: 'Tous les modes',
  workModeRemote: 'Télétravail',
  workModeHybrid: 'Hybride ou télétravail',
  workModeOnsite: 'Sur place',
  salaryLabel: 'Salaire minimum',
  salaryAny: 'Aucun minimum',
  experienceLabel: 'Votre expérience',
  experienceAny: 'Tous les niveaux',
  experience0to2: '0 à 2 ans',
  experience3to5: '3 à 5 ans',
  experience6to9: '6 à 9 ans',
  experience10plus: '10 ans et plus',
  staffingLabel: 'Agences de placement',
  staffingAcceptable: 'Acceptables — garder les offres, montrer le signal',
  staffingExclude: 'Exclure les offres publiées par des agences',
  skillsButton: 'Définir vos compétences',
  skillsModalTitle: 'Vos compétences clés',
  skillsFieldLabel: 'Compétences clés (séparées par des virgules)',
  skillsPlaceholder: 'ex. TypeScript, Node.js, Vue',
  startButton: 'Lancer la recherche',
  cancelButton: 'Annuler',
  cancelled: 'Recherche annulée.',
  searchingWeb: 'Recherche de nouvelles offres sur le web…',
  stageEvaluating: 'Évaluation des offres selon vos réponses…',
  stageScoring: 'Notation des offres retenues…',
  stageResearching: 'Recherche d’infos sur les entreprises des meilleurs résultats…',
  alreadyRunning: 'Une recherche est déjà en cours pour vous — voici sa progression.',
  resultsTitle: 'Meilleurs résultats',
  resultsEmpty:
    'Aucune offre n’a passé vos filtres cette fois. Essayez un mode de travail plus large, un salaire minimum plus bas, ou d’autres mots-clés.',
  moreButton: 'Plus de résultats',
  pageLabel: 'Page {page} sur {pageCount}',
  scoreOverall: 'Note globale',
  scoreInterviewChance: 'Chance d’entrevue',
  scoreQuality: 'Qualité',
  intelPending: 'Infos entreprise : recherche toujours en cours — le rapport terminé sera dans le tableau de bord.',
  intelLabel: 'Infos entreprise',
  viewPosting: 'Voir l’offre',
  footer: 'Notes par JobRadar · détails complets dans le tableau de bord',
  channelFallback:
    '{mention} vos résultats JobRadar sont prêts — la fenêtre de réponse a expiré, les voici donc ici. Session n° {sessionId}',
  errorGeneric:
    'Un problème est survenu pendant la recherche. Le tableau de bord fonctionne toujours — réessayez dans un moment.',
  errorApiUnreachable: 'L’API JobRadar ne répond pas pour le moment. La pile est-elle démarrée ?',
  roleRequired:
    'Cette commande est réservée aux membres ayant le rôle JobRadar sur ce serveur — demandez au propriétaire du serveur.',
  wrongGuild: 'JobRadar répond uniquement sur son serveur configuré.',
  forgetDone: 'C’est fait — vos réponses JobRadar enregistrées sont effacées. La prochaine recherche repartira de zéro.',
  forgetNothing: 'Vous n’aviez aucune réponse JobRadar enregistrée — rien à effacer.',
  helpText:
    '**JobRadar sur Discord**\nLancez `/jobradar search`, dites ce que vous cherchez, puis ajustez les filtres (mode de travail, salaire minimum, expérience, agences de placement). JobRadar interroge ses sources, note les offres selon vos réponses, fait des recherches sur les meilleures entreprises, et publie vos meilleurs résultats ici même — **Plus de résultats** affiche les pages suivantes.\nVos réponses sont conservées sur la machine JobRadar pour que la prochaine recherche démarre pré-remplie ; `/jobradar forget` les efface. Les détails complets des notes sont dans le tableau de bord.\nNote : ce que vous écrivez au bot passe par les serveurs de Discord, comme tout message Discord. En message privé, il n’y a pas de messages éphémères (visibles par vous seul) : les réponses s’affichent dans la conversation elle-même.',
};

export const BOT_CATALOGS: Record<BotLocale, BotStrings> = { en: enStrings, fr: frStrings };

/** Discord reports locales like 'en-US' or 'fr-CA'; the bot carries en + fr. */
export function resolveBotLocale(discordLocale: string | null | undefined): BotLocale {
  return discordLocale?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function translate(
  locale: BotLocale,
  key: BotStringKey,
  params: Record<string, string | number> = {},
): string {
  let text = BOT_CATALOGS[locale][key] ?? BOT_CATALOGS.en[key];
  for (const [paramName, paramValue] of Object.entries(params)) {
    text = text.replaceAll(`{${paramName}}`, String(paramValue));
  }
  return text;
}
