/**
 * Output-language (i18n) control for GENERATED documentation.
 *
 * Single source of truth for the human language of generated prose. The locale is
 * set once from the CLI `--lang` flag (see cli/index.ts preAction) and read by:
 *   - LLMService.complete() — prepends `llmLanguageDirective()` to the system prompt
 *     so LLM-authored prose (generate / decisions / drift) comes out in the target
 *     language;
 *   - the Markdown formatters — call `t()` for their hardcoded section headings and
 *     fixed sentences.
 *
 * Invariant (project requirement): only natural-language prose is translated. File
 * paths, code identifiers, RFC-2119 keywords (SHALL/MUST/SHOULD) and the
 * GIVEN/WHEN/THEN scenario markers stay in English — validators and parsers
 * (`openspec validate`, digest/drift) match them literally.
 */

export type Locale = 'en' | 'ru';

const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ru'];

let currentLocale: Locale = 'en';

/** Set the output locale from a raw CLI/env value. Throws on unsupported values. */
export function setLocale(locale: string | undefined | null): void {
  if (!locale) return;
  const normalized = locale.toLowerCase();
  if (!SUPPORTED_LOCALES.includes(normalized as Locale)) {
    throw new Error(
      `Unsupported language '${locale}'. Supported: ${SUPPORTED_LOCALES.join(', ')}.`
    );
  }
  currentLocale = normalized as Locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Directive appended to LLM system prompts so generated prose uses the target
 * language. The directive is written in English (it instructs the model) and is
 * empty for the default English locale, so behavior is unchanged unless a
 * non-English language is requested.
 */
const LLM_DIRECTIVES: Record<Locale, string> = {
  en: '',
  ru:
    'Write ALL natural-language prose (descriptions, purposes, rationale, summaries, ' +
    'and the text inside GIVEN/WHEN/THEN scenarios) in Russian. ' +
    'Keep the following in their original English form, never translated: file and ' +
    'directory paths, code identifiers (type, function, class, variable names), HTTP ' +
    'methods, JSON keys, CLI commands and flags, capability names, and the keywords ' +
    'SHALL / MUST / SHOULD / MAY and GIVEN / WHEN / THEN / AND.',
};

export function llmLanguageDirective(): string {
  return LLM_DIRECTIVES[currentLocale];
}
