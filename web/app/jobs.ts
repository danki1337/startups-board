export type Job = {
  id: string;
  title: string;
  company: string;
  companyMark: string;
  companyLogoUrl?: string | null;
  companyColor: string;
  location: string;
  country?: string | null;
  city?: string | null;
  roleFamily?: string | null;
  companyIndustry?: string | null;
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
  source: "Ashby" | "BambooHR" | "Gem" | "Getro" | "Greenhouse" | "iCIMS" | "Lever" | "Paylocity" | "Rippling" | "SmartRecruiters" | "Spark Hire" | "Workday";
  postedDaysAgo?: number;
  publishedAt?: string | null;
  skills: string[];
  description: string;
  url: string;
};

// The sample job fixture that used to live here was removed: the page now server-renders the
// real index, so a fallback dataset could only ever mask a broken database with fake rows.


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
  "Rippling",
  "SmartRecruiters",
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
