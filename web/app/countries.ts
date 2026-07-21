// Generated from src/locations.mjs -- keep the two in sync. The browser only needs display
// helpers (flag emoji, country names) and the picker list; detection stays server-side at ingestion.
const COUNTRY_NAMES: Record<string, string> = {
  ar: "Argentina", at: "Austria", au: "Australia", be: "Belgium", br: "Brazil", ca: "Canada",
  ch: "Switzerland", cl: "Chile", cn: "China", co: "Colombia", cz: "Czechia", de: "Germany",
  dk: "Denmark", ee: "Estonia", eg: "Egypt", es: "Spain", fi: "Finland", fr: "France",
  gb: "United Kingdom", gr: "Greece", hk: "Hong Kong", hr: "Croatia", hu: "Hungary", id: "Indonesia",
  ie: "Ireland", il: "Israel", in: "India", it: "Italy", jp: "Japan", ke: "Kenya", kr: "South Korea",
  lt: "Lithuania", lu: "Luxembourg", lv: "Latvia", mx: "Mexico", my: "Malaysia", ng: "Nigeria",
  nl: "Netherlands", no: "Norway", nz: "New Zealand", pe: "Peru", ph: "Philippines", pl: "Poland",
  pt: "Portugal", ro: "Romania", rs: "Serbia", sa: "Saudi Arabia", se: "Sweden", sg: "Singapore",
  si: "Slovenia", sk: "Slovakia", th: "Thailand", tr: "Turkey", tw: "Taiwan", ua: "Ukraine",
  ae: "United Arab Emirates", us: "United States", vn: "Vietnam", za: "South Africa",
  mt: "Malta", is: "Iceland", bg: "Bulgaria",
};

export function countryFlag(code?: string | null): string | null {
  if (!code || code.length !== 2) return null;
  return String.fromCodePoint(
    ...[...code.toLowerCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 97),
  );
}

export function countryName(code?: string | null): string | null {
  return (code && COUNTRY_NAMES[code]) || null;
}

export const COUNTRY_OPTIONS = Object.entries(COUNTRY_NAMES)
  .map(([code, name]) => ({ code, name, flag: countryFlag(code) as string }))
  .sort((left, right) => left.name.localeCompare(right.name));
