// Localization: the engine's string tables (assets/strings.json, US-English
// text as the keys, the nine StarHermit locales; the shared account lines are
// the engine's `starhermit.*`) in the interface language the runtime reports
// (the player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replaced the game's own
// Language selector (sh-language.js).
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export function currentLocale(): string { return strings.locale; }

type Vars = Record<string, string | number>;
const fill = (s: string, vars: Vars): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));
/** An English source string in the player's language; `{name}` placeholders from vars. An unknown key shows as itself. */
export function T(key: string, vars?: Vars | null): string {
  if (strings.has(key)) return strings.t(key, vars ?? undefined);
  return vars ? fill(key, vars) : key;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The engine's account lines. */
export const SH = (key: string, vars?: Vars): string => strings.t(`starhermit.${key}`, vars);
