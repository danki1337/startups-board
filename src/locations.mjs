// Derive an ISO 3166-1 alpha-2 country from the free-text location an ATS returns.
//
// There are ~19,600 distinct location strings in the index and no structured country field in any
// provider payload, so the country is resolved once at ingestion and stored, rather than guessed in
// SQL at query time. Unresolved locations keep a null country and simply do not appear under a
// country filter -- that is preferable to guessing wrong and hiding real jobs.

const COUNTRY_NAMES = {
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

// Written longest-first at match time so "United States" cannot be shadowed by a shorter alias.
const COUNTRY_ALIASES = {
  // Bare "us" is safe only because matching enforces word boundaries; it resolves the very common
  // "US Remote" / "Remote - US" / "Remote, US" strings that otherwise fall through unresolved.
  us: ["united states", "usa", "u.s.a", "u.s.", "america", "us"],
  gb: ["united kingdom", "great britain", "england", "scotland", "wales", "northern ireland", "uk"],
  ae: ["united arab emirates", "uae", "dubai", "abu dhabi"],
  kr: ["south korea", "republic of korea", "seoul"],
  cz: ["czech republic", "czechia"],
  nl: ["netherlands", "holland"],
  ch: ["switzerland", "schweiz"],
  de: ["germany", "deutschland"],
};

const US_STATES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks",
  "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny",
  "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy", "dc",
]);

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
];

// Only cities distinctive enough that the mapping is unambiguous in practice.
const CITIES = {
  us: ["san francisco", "new york", "nyc", "austin", "seattle", "boston", "chicago", "los angeles",
    "san diego", "denver", "atlanta", "miami", "dallas", "houston", "philadelphia", "phoenix",
    "portland", "san jose", "palo alto", "mountain view", "menlo park", "sunnyvale", "santa clara",
    "cambridge, ma", "brooklyn", "bellevue", "redmond", "hawthorne", "costa mesa"],
  gb: ["london", "manchester", "edinburgh", "bristol", "cambridge, uk", "oxford", "glasgow", "leeds"],
  de: ["berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln", "stuttgart"],
  fr: ["paris", "lyon", "marseille", "toulouse", "bordeaux", "lille"],
  nl: ["amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague"],
  es: ["madrid", "barcelona", "valencia", "seville", "málaga", "malaga"],
  ie: ["dublin", "cork", "galway"],
  ca: ["toronto", "vancouver", "montreal", "montréal", "ottawa", "calgary", "waterloo", "edmonton"],
  au: ["sydney", "melbourne", "brisbane", "perth", "canberra", "adelaide"],
  in: ["bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai", "gurgaon",
    "gurugram", "noida", "kolkata"],
  sg: ["singapore"],
  jp: ["tokyo", "osaka", "kyoto", "yokohama"],
  cn: ["beijing", "shanghai", "shenzhen", "guangzhou", "hangzhou"],
  il: ["tel aviv", "jerusalem", "haifa", "herzliya"],
  br: ["são paulo", "sao paulo", "rio de janeiro", "belo horizonte", "brasil"],
  mx: ["mexico city", "guadalajara", "monterrey", "ciudad de méxico"],
  pl: ["warsaw", "warszawa", "kraków", "krakow", "wrocław", "wroclaw", "gdańsk", "gdansk"],
  pt: ["lisbon", "lisboa", "porto"],
  se: ["stockholm", "gothenburg", "göteborg", "malmö"],
  ch: ["zurich", "zürich", "geneva", "genève", "basel", "lausanne"],
  at: ["vienna", "wien", "graz", "salzburg", "linz"],
  dk: ["copenhagen", "københavn", "aarhus"],
  no: ["oslo", "bergen", "trondheim"],
  fi: ["helsinki", "espoo", "tampere"],
  it: ["milan", "milano", "rome", "roma", "turin", "torino", "bologna"],
  be: ["brussels", "bruxelles", "antwerp", "ghent", "leuven"],
  cz: ["prague", "praha", "brno"],
  ro: ["bucharest", "bucurești", "cluj", "cluj-napoca", "timișoara", "iasi"],
  ua: ["kyiv", "kiev", "lviv", "kharkiv", "odesa"],
  tr: ["istanbul", "ankara", "izmir"],
  za: ["cape town", "johannesburg", "durban", "pretoria"],
  ke: ["nairobi", "mombasa"],
  ng: ["lagos", "abuja"],
  ph: ["manila", "cebu", "makati", "taguig"],
  my: ["kuala lumpur", "penang"],
  th: ["bangkok", "chiang mai"],
  vn: ["hanoi", "ho chi minh", "da nang"],
  id: ["jakarta", "bandung", "surabaya"],
  ar: ["buenos aires", "córdoba, argentina"],
  cl: ["santiago, chile"],
  co: ["bogotá", "bogota", "medellín", "medellin"],
  nz: ["auckland", "wellington", "christchurch"],
  hk: ["hong kong"],
  tw: ["taipei", "taiwan"],
  eg: ["cairo", "giza"],
  gr: ["athens", "thessaloniki"],
  hu: ["budapest"],
  lt: ["vilnius", "kaunas"],
  lv: ["riga"],
  ee: ["tallinn", "tartu"],
  hr: ["zagreb", "split"],
  rs: ["belgrade", "novi sad"],
  si: ["ljubljana"],
  sk: ["bratislava"],
  sa: ["riyadh", "jeddah"],
  pe: ["lima, peru"],
  lu: ["luxembourg"],
};

// Precomputed longest-first so "new york" wins over "york" and "united states" over "states".
const NEEDLES = buildNeedles();

function buildNeedles() {
  const entries = [];
  for (const [code, name] of Object.entries(COUNTRY_NAMES)) entries.push([name.toLowerCase(), code]);
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    for (const alias of aliases) entries.push([alias, code]);
  }
  for (const [code, cities] of Object.entries(CITIES)) {
    for (const city of cities) entries.push([city, code]);
  }
  for (const state of US_STATE_NAMES) entries.push([state, "us"]);
  return entries.sort((left, right) => right[0].length - left[0].length);
}

// "Remote", "Worldwide", "Anywhere" and friends name no country at all. They are the single largest
// unresolved group, so they get their own bucket rather than being lumped in with genuine unknowns.
const ANYWHERE_PATTERN =
  /^(?:100%\s*)?(?:fully\s*)?(?:remote|anywhere|worldwide|world\s*wide|global|distributed|hybrid)\b[\s\-—,()]*(?:remote|anywhere|worldwide|global|first|friendly|ok|only)?[\s\-—,()]*$/;

export function isAnywhere(value) {
  const text = String(value ?? "").toLowerCase().trim();
  return Boolean(text) && ANYWHERE_PATTERN.test(text);
}

export function locationCountry(value) {
  const text = String(value ?? "").toLowerCase().trim();
  if (!text) return null;
  if (isAnywhere(text)) return null;

  for (const [needle, code] of NEEDLES) {
    if (!text.includes(needle)) continue;
    // Reject substring hits inside a longer word ("indiana" must not resolve via "india").
    const index = text.indexOf(needle);
    const before = text[index - 1];
    const after = text[index + needle.length];
    if (before && /[a-z]/.test(before)) continue;
    if (after && /[a-z]/.test(after)) continue;
    return code;
  }

  // Trailing US state codes, e.g. "Austin, TX" or "Hawthorne, CA".
  const stateMatch = /(?:^|[,\s])([a-z]{2})(?:[,\s]|$)/g;
  let match;
  while ((match = stateMatch.exec(text)) !== null) {
    if (US_STATES.has(match[1])) return "us";
  }
  return null;
}

// Canonical display label for the city needles above, so "San Francisco, CA", "san francisco" and
// "SF Bay Area" all collapse to one selectable value. Only the curated CITIES list resolves --
// there are ~19,600 distinct raw location strings and no dropdown can or should list them all.
const CITY_LABELS = new Map();
for (const [code, cities] of Object.entries(CITIES)) {
  for (const city of cities) {
    const base = city.split(",")[0];
    const label = base.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
    if (!CITY_LABELS.has(city)) CITY_LABELS.set(city, { label, code });
  }
}

// Longest-first for the same reason as country needles: "new york" must beat "york".
const CITY_NEEDLES = [...CITY_LABELS.entries()].sort((a, b) => b[0].length - a[0].length);

export function locationCity(value) {
  const text = String(value ?? "").toLowerCase().trim();
  if (!text || isAnywhere(text)) return null;
  for (const [needle, entry] of CITY_NEEDLES) {
    const index = text.indexOf(needle);
    if (index < 0) continue;
    const before = text[index - 1];
    const after = text[index + needle.length];
    if (before && /[a-z]/.test(before)) continue;
    if (after && /[a-z]/.test(after)) continue;
    return entry.label;
  }
  return null;
}

export function listCities() {
  const seen = new Map();
  for (const { label, code } of CITY_LABELS.values()) {
    if (!seen.has(label)) seen.set(label, { name: label, country: code });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function countryName(code) {
  return COUNTRY_NAMES[code] ?? null;
}

export function countryFlag(code) {
  if (!code || code.length !== 2) return null;
  // Regional indicator symbols: 'a' -> U+1F1E6.
  return String.fromCodePoint(
    ...[...code.toLowerCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 97),
  );
}

export function listCountries() {
  return Object.entries(COUNTRY_NAMES)
    .map(([code, name]) => ({ code, name, flag: countryFlag(code) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
