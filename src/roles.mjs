// Collapse a free-text job title into a selectable role family.
//
// There are ~99,000 distinct titles in the index and the 200 most common cover only 11% of
// postings, so a dropdown of raw titles is useless. Seniority prefixes ("Senior", "Staff", "II")
// and company-specific phrasing are exactly what makes titles unique, and exactly what a filter
// should ignore. Resolved once at ingestion and stored, like country and city.
//
// Ordered most specific first: "Sales Engineer" must land in Sales Engineering, not Sales or
// Software Engineering, so the first match wins and narrow families precede broad ones.

const ROLE_FAMILIES = [
  ["Data Science & Analytics", [
    "data scientist", "data science", "data analyst", "analytics engineer", "business analyst",
    "bi analyst", "business intelligence", "statistician", "biostatistician", "quantitative analyst",
  ]],
  ["Machine Learning & AI", [
    "machine learning", "ml engineer", "ai engineer", "deep learning", "research scientist",
    "applied scientist", "nlp", "computer vision", "ai researcher", "research engineer",
    "prompt engineer", "ai red teamer",
  ]],
  ["Data Engineering", ["data engineer", "etl", "data platform", "data infrastructure", "big data"]],
  ["DevOps & Infrastructure", [
    "devops", "site reliability", "sre", "platform engineer", "infrastructure engineer",
    "cloud engineer", "systems engineer", "network engineer", "database administrator", "dba",
  ]],
  ["Security", [
    "security engineer", "security analyst", "cybersecurity", "information security", "infosec",
    "penetration test", "appsec", "security architect", "soc analyst",
  ]],
  ["QA & Testing", ["qa engineer", "quality assurance", "test engineer", "sdet", "automation engineer"]],
  ["Mobile Engineering", ["ios engineer", "android engineer", "mobile engineer", "ios developer", "android developer"]],
  ["Sales Engineering", ["sales engineer", "solutions engineer", "solutions architect", "solution architect", "pre-sales", "presales"]],
  ["Software Engineering", [
    "software engineer", "software developer", "backend", "back-end", "frontend", "front-end",
    "full stack", "fullstack", "web developer", "engineering manager", "developer", "programmer",
    "software architect", "forward deployed engineer", ".net", "java engineer", "python engineer",
    "product engineer", "gtm engineer", "design engineer", "deployment strategist",
  ]],
  ["Product Management", ["product manager", "product owner", "technical product", "product lead", "head of product"]],
  ["Design & UX", [
    "product designer", "ux designer", "ui designer", "ux researcher", "graphic designer",
    "visual designer", "design lead", "creative director", "user experience",
  ]],
  ["Customer Success & Support", [
    "customer success", "customer support", "customer service", "account manager", "client success",
    "technical support", "support engineer", "help desk", "customer experience", "call center",
  ]],
  ["Sales & Business Development", [
    "account executive", "sales development", "business development", "sales manager",
    "sales representative", "sales associate", "territory", "inside sales", "sales director",
    "partnerships", "sdr", "bdr", "revenue",
  ]],
  ["Marketing & Communications", [
    "marketing", "content writer", "copywriter", "seo", "social media", "brand manager",
    "communications", "public relations", "growth manager", "demand generation", "product marketing",
  ]],
  ["Finance & Accounting", [
    "accountant", "accounting", "financial analyst", "finance manager", "controller", "bookkeeper",
    "auditor", "payroll", "treasury", "tax ", "fp&a", "underwriter",
  ]],
  ["People & Recruiting", [
    "recruiter", "talent acquisition", "human resources", "hr manager", "hr generalist",
    "people operations", "people partner", "hrbp", "sourcer", "compensation",
  ]],
  ["Legal & Compliance", [
    "counsel", "attorney", "paralegal", "legal", "compliance", "regulatory affairs", "privacy",
  ]],
  ["Healthcare & Clinical", [
    "nurse", "rn ", "registered nurse", "physician", "medical assistant", "therapist", "clinician",
    "pharmacist", "caregiver", "behavior technician", "behavior analyst", "bcba", "physical therap", "occupational therap",
    "dental", "veterinar", "phlebotom", "radiolog", "clinical",
  ]],
  ["Education & Training", ["teacher", "instructor", "tutor", "professor", "trainer", "curriculum", "faculty", "educator"]],
  ["Retail & Hospitality", [
    "store manager", "cashier", "barista", "server", "bartender", "cook", "chef", "housekeep",
    "front desk", "retail", "shift supervisor", "sales associate", "restaurant", "hotel",
  ]],
  ["Logistics & Transport", [
    "driver", "warehouse", "forklift", "logistics", "supply chain", "dispatcher", "courier",
    "truck", "delivery", "fleet", "inventory",
  ]],
  ["Manufacturing & Trades", [
    "technician", "machinist", "welder", "electrician", "plumber", "mechanic", "assembler",
    "maintenance", "production operator", "manufacturing", "quality inspector", "installer",
    "operator", "construction", "carpenter", "hvac",
  ]],
  ["Engineering (non-software)", [
    "mechanical engineer", "electrical engineer", "civil engineer", "chemical engineer",
    "industrial engineer", "process engineer", "manufacturing engineer", "aerospace", "structural",
  ]],
  ["Project & Program Management", ["project manager", "program manager", "scrum master", "delivery manager", "pmo", "project coordinator"]],
  ["Operations", ["operations manager", "operations analyst", "operations associate", "business operations", "chief of staff", "general manager"]],
  ["Executive & Leadership", [
    "chief executive", "chief financial", "chief technology", "chief operating", "chief marketing",
    "chief product", "ceo", "cfo", "cto", "coo", "vice president", "vp ", "president", "director of",
  ]],
  ["Administrative", ["administrative assistant", "executive assistant", "office manager", "receptionist", "data entry", "clerk", "coordinator"]],
  ["Research & Science", ["scientist", "research associate", "laboratory", "lab technician", "chemist", "biologist", "postdoc"]],
  ["Consulting", ["consultant", "advisory", "strategy manager", "management consultant"]],
];

export const ROLE_FAMILY_NAMES = ROLE_FAMILIES.map(([name]) => name).sort((a, b) => a.localeCompare(b));

export function roleFamily(title) {
  const text = ` ${String(title ?? "").toLowerCase().replace(/[^a-z0-9&.+ ]+/g, " ").replace(/\s+/g, " ")} `;
  if (text.trim().length === 0) return null;
  for (const [name, needles] of ROLE_FAMILIES) {
    for (const needle of needles) {
      if (text.includes(needle)) return name;
    }
  }
  return null;
}
