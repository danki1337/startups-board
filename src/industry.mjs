// Classify a company into a coarse industry.
//
// No ATS payload carries company industry except SmartRecruiters, so this is derived. Priority:
//   1. SmartRecruiters' native industry label (authoritative, but ~one provider only)
//   2. Company-name keywords (consistent per company: "Mercy Hospital" -> Healthcare)
//   3. The job's role family as a weak fallback (a company of nurses is a Healthcare company)
// Anything unresolved stays null and simply does not appear under the filter, rather than being
// guessed into the wrong bucket.

const INDUSTRIES = [
  "Technology & Software",
  "Healthcare & Life Sciences",
  "Financial Services",
  "Retail & Consumer",
  "Manufacturing & Industrial",
  "Education",
  "Hospitality & Food",
  "Transportation & Logistics",
  "Media & Marketing",
  "Energy & Utilities",
  "Real Estate & Construction",
  "Professional Services",
  "Government & Nonprofit",
];
export const INDUSTRY_NAMES = [...INDUSTRIES].sort((a, b) => a.localeCompare(b));

// SmartRecruiters industry ids/labels -> our canonical buckets.
const SR_MAP = new Map(Object.entries({
  computer_software: "Technology & Software",
  information_technology_and_services: "Technology & Software",
  internet: "Technology & Software",
  computer_hardware: "Technology & Software",
  telecommunications: "Technology & Software",
  semiconductors: "Technology & Software",
  hospital_health_care: "Healthcare & Life Sciences",
  medical_devices: "Healthcare & Life Sciences",
  pharmaceuticals: "Healthcare & Life Sciences",
  biotechnology: "Healthcare & Life Sciences",
  mental_health_care: "Healthcare & Life Sciences",
  banking: "Financial Services",
  financial_services: "Financial Services",
  insurance: "Financial Services",
  investment_management: "Financial Services",
  investment_banking: "Financial Services",
  accounting: "Financial Services",
  venture_capital_private_equity: "Financial Services",
  retail: "Retail & Consumer",
  consumer_goods: "Retail & Consumer",
  consumer_electronics: "Retail & Consumer",
  apparel_fashion: "Retail & Consumer",
  luxury_goods_jewelry: "Retail & Consumer",
  wholesale: "Retail & Consumer",
  manufacturing: "Manufacturing & Industrial",
  machinery: "Manufacturing & Industrial",
  automotive: "Manufacturing & Industrial",
  industrial_automation: "Manufacturing & Industrial",
  aviation_aerospace: "Manufacturing & Industrial",
  chemicals: "Manufacturing & Industrial",
  education_management: "Education",
  higher_education: "Education",
  e_learning: "Education",
  primary_secondary_education: "Education",
  hospitality: "Hospitality & Food",
  restaurants: "Hospitality & Food",
  food_beverages: "Hospitality & Food",
  food_production: "Hospitality & Food",
  leisure_travel_tourism: "Hospitality & Food",
  logistics_supply_chain: "Transportation & Logistics",
  transportation_trucking_railroad: "Transportation & Logistics",
  airlines_aviation: "Transportation & Logistics",
  package_freight_delivery: "Transportation & Logistics",
  marketing_and_advertising: "Media & Marketing",
  media_production: "Media & Marketing",
  entertainment: "Media & Marketing",
  broadcast_media: "Media & Marketing",
  publishing: "Media & Marketing",
  online_media: "Media & Marketing",
  oil_energy: "Energy & Utilities",
  utilities: "Energy & Utilities",
  renewables_environment: "Energy & Utilities",
  real_estate: "Real Estate & Construction",
  construction: "Real Estate & Construction",
  architecture_planning: "Real Estate & Construction",
  civil_engineering: "Real Estate & Construction",
  management_consulting: "Professional Services",
  legal_services: "Professional Services",
  staffing_and_recruiting: "Professional Services",
  human_resources: "Professional Services",
  government_administration: "Government & Nonprofit",
  nonprofit_organization_management: "Government & Nonprofit",
  civic_social_organization: "Government & Nonprofit",
}));

// Company-name keyword hints, checked as whole words. Ordered by specificity is not needed here
// because each phrase maps to exactly one bucket; the first hit wins.
const NAME_HINTS = [
  ["Healthcare & Life Sciences", ["hospital", "health", "healthcare", "clinic", "medical", "dental",
    "pharma", "biotech", "bioscience", "therapeutics", "care", "wellness", "nursing", "hospice",
    "diagnostics", "genomics", "life sciences", "vet", "veterinary"]],
  ["Financial Services", ["bank", "capital", "financial", "finance", "insurance", "invest",
    "wealth", "credit union", "mortgage", "lending", "payments", "fintech", "asset management",
    "securities", "trading", "advisors", "advisory"]],
  ["Education", ["university", "college", "school", "academy", "education", "learning", "institute",
    "montessori", "tutoring", "campus"]],
  ["Retail & Consumer", ["retail", "store", "shop", "market", "grocery", "brands", "apparel",
    "cosmetics", "outfitters", "boutique", "goods"]],
  ["Hospitality & Food", ["hotel", "resort", "restaurant", "grill", "kitchen", "cafe", "coffee",
    "brewing", "brewery", "foods", "catering", "hospitality", "dining", "eatery"]],
  ["Transportation & Logistics", ["logistics", "freight", "trucking", "transport", "shipping",
    "airlines", "aviation", "cargo", "delivery", "fleet", "rail"]],
  ["Manufacturing & Industrial", ["manufacturing", "industries", "industrial", "steel", "machinery",
    "automotive", "motors", "aerospace", "materials", "fabrication", "foundry", "mills"]],
  ["Energy & Utilities", ["energy", "solar", "power", "electric", "utilities", "petroleum", "oil",
    "gas", "renewables", "grid"]],
  ["Real Estate & Construction", ["real estate", "realty", "properties", "construction", "builders",
    "homes", "roofing", "contracting", "architecture", "development group"]],
  ["Media & Marketing", ["media", "marketing", "advertising", "studios", "entertainment",
    "productions", "creative", "agency", "publishing", "games", "gaming"]],
  ["Government & Nonprofit", ["county", "city of", "state of", "department of", "foundation",
    "nonprofit", "ministry", "council", "authority", "district", "government"]],
  ["Technology & Software", ["software", "technolog", "labs", "systems", "digital", "cloud", "data",
    "cyber", "robotics", "semiconductor", "computing", "networks", "app", "platform", ".ai", " ai",
    "analytics", "devices"]],
];

// Weak fallback: the family of role the posting is for. Restricted to families that indicate a
// company's *core* workforce — a company of nurses is a healthcare company, of machinists a
// manufacturer. Deliberately excludes cross-cutting functions (Finance & Accounting, Marketing,
// HR, Legal) that exist at every company: an accountant does not make an employer a bank, so those
// industries are only assigned from an explicit company-name signal, never from the role.
const ROLE_TO_INDUSTRY = {
  "Healthcare & Clinical": "Healthcare & Life Sciences",
  "Software Engineering": "Technology & Software",
  "Machine Learning & AI": "Technology & Software",
  "Data Engineering": "Technology & Software",
  "DevOps & Infrastructure": "Technology & Software",
  "Security": "Technology & Software",
  "Retail & Hospitality": "Retail & Consumer",
  "Manufacturing & Trades": "Manufacturing & Industrial",
  "Logistics & Transport": "Transportation & Logistics",
  "Education & Training": "Education",
};

function fromName(name) {
  const text = ` ${String(name ?? "").toLowerCase().replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ")} `;
  if (text.trim().length === 0) return null;
  for (const [industry, phrases] of NAME_HINTS) {
    for (const phrase of phrases) {
      if (text.includes(` ${phrase} `) || text.includes(`${phrase} `) || text.includes(phrase)) {
        // Require the phrase to sit on a word boundary to avoid "care" matching "careers".
        const index = text.indexOf(phrase);
        const before = text[index - 1];
        const after = text[index + phrase.length];
        const boundaryBefore = !before || !/[a-z0-9]/.test(before);
        const boundaryAfter = !after || !/[a-z0-9]/.test(after);
        if (boundaryBefore && boundaryAfter) return industry;
      }
    }
  }
  return null;
}

export function classifyIndustry({ companyName, roleFamily, smartRecruitersIndustry } = {}) {
  if (smartRecruitersIndustry) {
    const key = String(smartRecruitersIndustry).toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
    if (SR_MAP.has(key)) return SR_MAP.get(key);
  }
  const byName = fromName(companyName);
  if (byName) return byName;
  return ROLE_TO_INDUSTRY[roleFamily] ?? null;
}
