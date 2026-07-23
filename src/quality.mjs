// Reject the small set of postings that are recruitment scams or offshore job-spam rather than real
// openings. This runs at ingestion, so a match keeps the posting out of the active index entirely.
//
// Precision is the whole point: a false positive silently hides a real job, so every pattern here is
// a phrase that legitimate ATS postings essentially never use. Loose keywords are deliberately
// avoided -- "whatsapp" alone would hit Meta's WhatsApp roles, "loan" would hit Loan Officer, so the
// patterns require the surrounding fraud context ("free airfare", "project funding offer", the
// MT760/SBLC instrument-fraud vocabulary, an "urgent vacancy" spam headline).
const SCAM_PATTERNS = [
  // Visa/relocation placement fraud: "$4800USD/MONTHLY ESL TEACHING JOB WITH FREE AIRFARE AND
  // ACCOMMODATION IN DUBAI". No real employer advertises free airfare/visa in the job title.
  /\bfree\s+(airfares?|accommodations?|accomodations?|visas?|tickets?|flights?)\b/,
  // A salary baked into the title as "$4800USD/MONTHLY" is a job-spam tell, not an ATS convention.
  /\busd\s*\/\s*month(ly)?\b/,
  // Advance-fee / fake trade-finance fraud: "LOAN, BG/SBLC MT760 AND PROJECT FUNDING OFFER!!!".
  /\bbg\s*\/\s*sblc\b/,
  /\bmt\s?(760|103)\b/,
  /\bproject\s+funding\s+offer\b/,
  // Offshore job-spam headlines: "URGENT VACANCY FOR BANKING SECTOR", "URGENT OPENING MECHANICAL
  // ENGINEER". A genuine ATS posting is titled with the role, never a "URGENT VACANCY" banner.
  /\burgent\s+(vacancy|vacancies|opening|job\s+opening)\b/,
];

export function isLikelyScam(title) {
  const text = String(title ?? "").toLowerCase();
  if (!text) return false;
  return SCAM_PATTERNS.some((pattern) => pattern.test(text));
}
