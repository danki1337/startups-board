import { readFile } from "node:fs/promises";
import { parseAtsUrl } from "../../src/providers.mjs";

const endpoint = process.env.ADMIN_IMPORT_URL;
const token = process.env.ADMIN_TOKEN;
const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--")) ?? "data/discovered-boards.json";
const provider = valueOf("--provider");
// The reference merge added ~38k unverified identifiers, so production imports are staged by
// provider and restricted to boards a validation run actually proved reachable.
const onlyValidated = args.includes("--only-validated");
if (!endpoint || !token) throw new Error("ADMIN_IMPORT_URL and ADMIN_TOKEN are required");

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const payload = JSON.parse(await readFile(input, "utf8"));
const allBoards = Array.isArray(payload) ? payload : payload.boards;
if (!Array.isArray(allBoards)) throw new Error("The input file does not contain a boards array");

const inputBoards = allBoards.filter((board) => {
  if (provider && board.provider !== provider) return false;
  if (!onlyValidated) return true;
  const status = board.validation?.status;
  return status === "active" || status === "empty";
});
if (provider || onlyValidated) {
  console.log(`Filtered ${allBoards.length} -> ${inputBoards.length} boards`
    + `${provider ? ` (provider=${provider})` : ""}${onlyValidated ? " (validated only)" : ""}`);
}

const byKey = new Map();
for (const board of inputBoards) {
  const canonical = parseAtsUrl(board.boardUrl || board.apiUrl, board.provider);
  if (canonical) byKey.set(canonical.key, canonical);
}
const boards = [...byKey.values()];
console.log(`Prepared ${boards.length}/${inputBoards.length} valid canonical boards`);

let imported = 0;
for (let index = 0; index < boards.length; index += 2_000) {
  const batch = boards.slice(index, index + 2_000);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ boards: batch }),
  });
  if (!response.ok) throw new Error(`Import failed with HTTP ${response.status}: ${await response.text()}`);
  imported += batch.length;
  console.log(`Imported ${imported}/${boards.length} boards`);
}
