export type Job = {
  id: string;
  title: string;
  company: string;
  companyMark: string;
  companyLogoUrl?: string | null;
  companyColor: string;
  location: string;
  country?: string | null;
  countryFlag?: string | null;
  workplace: "Remote" | "Hybrid" | "On-site" | "Unspecified";
  employmentType: string | null;
  category:
    | "Engineering"
    | "AI & Research"
    | "Product & Design"
    | "Sales & Marketing"
    | "Operations"
    | "Other";
  source: "Ashby" | "BambooHR" | "Gem" | "Getro" | "Greenhouse" | "iCIMS" | "Lever" | "Paylocity" | "Spark Hire" | "Workday";
  postedDaysAgo?: number;
  publishedAt?: string | null;
  skills: string[];
  description: string;
  url: string;
};

export const jobs: Job[] = [
  {
    id: "1password-staff-identity",
    title: "Staff Developer, Identity",
    company: "1Password",
    companyMark: "1P",
    companyColor: "bg-[#ebe7ff] text-[#5436a8]",
    location: "Remote — Canada",
    workplace: "Remote",
    employmentType: "Full-time",
    category: "Engineering",
    source: "Ashby",
    postedDaysAgo: 1,
    skills: ["Identity", "Distributed systems", "TypeScript"],
    description:
      "Build the identity platform that keeps millions of people and businesses secure across every device.",
    url: "https://jobs.ashbyhq.com/1password",
  },
  {
    id: "10a-red-teamer",
    title: "AI Red Teamer",
    company: "10A Labs",
    companyMark: "10",
    companyColor: "bg-[#ffe8dc] text-[#9b3d0a]",
    location: "Remote — United States",
    workplace: "Remote",
    employmentType: "Full-time",
    category: "AI & Research",
    source: "Greenhouse",
    postedDaysAgo: 2,
    skills: ["AI safety", "Security", "Evaluation"],
    description:
      "Probe frontier systems, design adversarial evaluations, and turn findings into safer AI products.",
    url: "https://job-boards.greenhouse.io/10alabs",
  },
  {
    id: "blackshark-devsecops",
    title: "DevSecOps Engineer — Deployment Team",
    company: "Blackshark.ai",
    companyMark: "B",
    companyColor: "bg-[#e1f1ef] text-[#15645a]",
    location: "Graz, Austria",
    workplace: "Hybrid",
    employmentType: "Full-time",
    category: "Engineering",
    source: "Lever",
    postedDaysAgo: 2,
    skills: ["Kubernetes", "Cloud security", "CI/CD"],
    description:
      "Harden and automate the deployment platform behind a living, AI-powered 3D model of Earth.",
    url: "https://jobs.eu.lever.co/blackshark",
  },
  {
    id: "1mind-ai-engineer",
    title: "AI System Engineer",
    company: "1Mind",
    companyMark: "1M",
    companyColor: "bg-[#e8eefc] text-[#294f9f]",
    location: "San Francisco, CA",
    workplace: "Hybrid",
    employmentType: "Full-time",
    category: "AI & Research",
    source: "Ashby",
    postedDaysAgo: 3,
    skills: ["LLMs", "Python", "Agents"],
    description:
      "Ship agentic sales experiences that reason, respond, and improve from real customer conversations.",
    url: "https://jobs.ashbyhq.com/1mind",
  },
  {
    id: "1910-research-scientist",
    title: "AI Research Scientist II",
    company: "1910 Genetics",
    companyMark: "19",
    companyColor: "bg-[#f4e5ef] text-[#8c326d]",
    location: "Boston, MA",
    workplace: "On-site",
    employmentType: "Full-time",
    category: "AI & Research",
    source: "Greenhouse",
    postedDaysAgo: 4,
    skills: ["Machine learning", "Biology", "Drug discovery"],
    description:
      "Develop foundation models that help scientists find better medicines with fewer experiments.",
    url: "https://job-boards.greenhouse.io/1910genetics",
  },
  {
    id: "efficio-business-analyst",
    title: "Business Analyst — Dubai",
    company: "Efficio Consulting",
    companyMark: "E",
    companyColor: "bg-[#f1eadb] text-[#76551f]",
    location: "Dubai, UAE",
    workplace: "On-site",
    employmentType: "Full-time",
    category: "Operations",
    source: "Lever",
    postedDaysAgo: 4,
    skills: ["Analytics", "Strategy", "Procurement"],
    description:
      "Turn complex operational data into practical recommendations for global procurement teams.",
    url: "https://jobs.eu.lever.co/efficioconsulting",
  },
  {
    id: "control-policy-advisor",
    title: "Policy Advisor",
    company: "ControlAI",
    companyMark: "C",
    companyColor: "bg-[#e5efe3] text-[#386a31]",
    location: "London, United Kingdom",
    workplace: "Hybrid",
    employmentType: "Full-time",
    category: "Operations",
    source: "Lever",
    postedDaysAgo: 5,
    skills: ["AI governance", "Policy", "Research"],
    description:
      "Translate technical AI risk into policy that decision-makers can understand and act on.",
    url: "https://jobs.lever.co/controlai",
  },
  {
    id: "42dot-audio-dsp",
    title: "Audio DSP Engineer",
    company: "42dot",
    companyMark: "42",
    companyColor: "bg-[#e7ecf0] text-[#34495b]",
    location: "Seoul, South Korea",
    workplace: "On-site",
    employmentType: "Full-time",
    category: "Engineering",
    source: "Ashby",
    postedDaysAgo: 6,
    skills: ["Signal processing", "C++", "Embedded systems"],
    description:
      "Create robust speech and audio systems for software-defined vehicles and autonomous mobility.",
    url: "https://jobs.ashbyhq.com/42dot",
  },
  {
    id: "829-ai-innovation",
    title: "AI Innovation Engineer",
    company: "829 Studios",
    companyMark: "82",
    companyColor: "bg-[#fde9e8] text-[#9d3f3a]",
    location: "Boston, MA",
    workplace: "Hybrid",
    employmentType: "Full-time",
    category: "Engineering",
    source: "Ashby",
    postedDaysAgo: 7,
    skills: ["Prototyping", "LLMs", "Automation"],
    description:
      "Prototype applied AI tools that compress research, production, and campaign workflows.",
    url: "https://jobs.ashbyhq.com/829studios",
  },
  {
    id: "10beauty-operations",
    title: "Operations Program Manager",
    company: "10Beauty",
    companyMark: "10",
    companyColor: "bg-[#f8e7dc] text-[#9a4f20]",
    location: "Burlington, MA",
    workplace: "On-site",
    employmentType: "Full-time",
    category: "Operations",
    source: "Greenhouse",
    postedDaysAgo: 8,
    skills: ["Supply chain", "Hardware", "Program management"],
    description:
      "Own critical supply-chain programs for a robotics company reinventing the manicure experience.",
    url: "https://job-boards.greenhouse.io/10beauty",
  },
  {
    id: "21shares-product",
    title: "Product Manager",
    company: "21Shares",
    companyMark: "21",
    companyColor: "bg-[#e3ede9] text-[#326755]",
    location: "Zurich, Switzerland",
    workplace: "Hybrid",
    employmentType: "Full-time",
    category: "Product & Design",
    source: "Greenhouse",
    postedDaysAgo: 9,
    skills: ["Fintech", "Crypto", "Product strategy"],
    description:
      "Shape regulated digital-asset products used by investors across global markets.",
    url: "https://job-boards.greenhouse.io/21shares",
  },
  {
    id: "diabolocom-ai-research",
    title: "AI Research Engineer — Speech",
    company: "Diabolocom",
    companyMark: "D",
    companyColor: "bg-[#eee8fa] text-[#6742a3]",
    location: "Paris, France",
    workplace: "Hybrid",
    employmentType: "Full-time",
    category: "AI & Research",
    source: "Lever",
    postedDaysAgo: 10,
    skills: ["Speech AI", "NLP", "Python"],
    description:
      "Research and productionize speech systems for high-volume, multilingual customer conversations.",
    url: "https://jobs.eu.lever.co/diabolocom",
  },
];

export const workplaceOptions: Job["workplace"][] = ["Remote", "Hybrid", "On-site", "Unspecified"];
export const sourceOptions: Job["source"][] = [
  "Ashby",
  "BambooHR",
  "Gem",
  "Getro",
  "Greenhouse",
  "iCIMS",
  "Lever",
  "Paylocity",
  "Spark Hire",
  "Workday",
];
export const categoryOptions: Job["category"][] = [
  "Engineering",
  "AI & Research",
  "Product & Design",
  "Sales & Marketing",
  "Operations",
  "Other",
];
