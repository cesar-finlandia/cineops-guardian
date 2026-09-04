// Requirement IDs: PROV-01, PROV-02, PROV-03, PROV-04, PROV-REU-01, XCUT-08
// Disclosure generator core (DP-J §4) — pure, synchronous, LLM-free.
//
// generateDisclosure(manifestBytes, aiLogBytes|null, catalog, config?, opts?)
//   -> { disclosure_text, architecture_summary, components_reused, ai_tool_log,
//        source_manifest_hash, generated_at, warnings }
//
// Accuracy invariant (PROV-04): the rendered text claims exactly the manifest's
// components.filter(c=>c.included) — one bullet per included id in manifest
// order, zero mentions of excluded ids unless the optional footnote is enabled.
// Every noun comes from the manifest or contracts/component-catalog.json;
// nothing is paraphrased, summarized, or invented (PROV-REU-01). Re-running is
// safe and idempotent modulo generated_at/source_manifest_hash (PROV-03).
//
// Imports limited to src/resilience/*, contracts/* and Node stdlib
// (GOV-REU-03, DP-J §9.4). No network anywhere.

import { createHash } from "node:crypto";

import { validate } from "../../resilience/index.js";
import {
  loadAssemblyManifestSchema,
  validateAiLogEntry,
} from "./validate.js";
import { buildArchitectureSummary } from "./summary.js";

/** Catalog entry view of contracts/component-catalog.json (read-only). */
export interface CatalogEntry {
  id: string;
  display_name: string;
  description: string;
  requires_env?: string[];
  requires_providers?: string[];
  gov_min_hint?: string;
  sub_components?: string[];
}

export interface ComponentCatalog {
  version?: string;
  components: CatalogEntry[];
}

/** Manifest component entry per contracts/assembly-manifest.schema.json. */
export interface ManifestComponent {
  id: string;
  included: boolean;
  version?: string;
  requires_env?: string[];
  requires_providers?: string[];
}

export interface AssemblyManifest {
  manifest_version: string;
  created_at?: string;
  chassis_version: string;
  components: ManifestComponent[];
  selection_rationale?: Array<{ id: string; decision: string; reason: string }>;
  git?: { initialized?: boolean; baseline_commit?: string | null };
}

/** AI-tool log entry per DP-J §4.2 (tool 1–40 chars, scope 5–400 chars). */
export interface AiToolLogEntry {
  tool: string;
  scope: string;
}

/** Knobs from config/disclosure.json (validated via RES-04 upstream). */
export interface DisclosureConfig {
  include_excluded_footnote?: boolean;
  short_sha_length?: number;
  cite_chassis_url?: string | null;
}

export interface GenerateOptions {
  /** ISO-8601 timestamp injected for determinism/tests; defaults to now. */
  now?: string;
}

export interface DisclosureResult {
  disclosure_text: string;
  architecture_summary: string;
  components_reused: string[];
  ai_tool_log: AiToolLogEntry[] | null;
  source_manifest_hash: string;
  source_ai_log_hash: string | null;
  generated_at: string;
  /** Non-fatal notes (malformed AI-log entries skipped per GOV-RES-02). */
  warnings: string[];
}

/** ASM-RES-01: invalid/missing manifest blocks disclosure — accuracy over
 * availability. Carries path/message/code per contracts/validation-error. */
export class ManifestValidationError extends Error {
  readonly path: string;
  readonly code: string;

  constructor(path: string, message: string, code = "manifest_invalid") {
    super(message);
    this.name = "ManifestValidationError";
    this.path = path;
    this.code = code;
  }
}

/** Repo integrity bug: a manifest id with no catalog coverage. */
export class CatalogError extends Error {
  readonly code = "catalog_missing_entry";

  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

//#region Catalog derivation — bullet description / requirement ids / role

/**
 * Requirement-id tokens are EXTRACTED from the catalog description — the
 * catalog (M04-owned, additionalProperties:false) has no dedicated field, so
 * the extraction chain below is the single deterministic rule set (documented
 * here because tests encode it):
 *   1. backticked ALL-CAPS tokens (`RES-*`, `DEP`, `CTX-02`) — lowercase
 *      backticked ids (`media/stt`, `prov`) never match;
 *   2. parenthesized slash-groups ((MOCK/EVAL/DOCTOR/TRACK/BENCH));
 *   3. bare ALL-CAPS words in the FIRST sentence only, when 1+2 found nothing
 *      (ideation → PIT/IDEA/RETRO; OPENAI_API_KEY/PLAYWRIGHT live in later
 *      sentences and are excluded);
 *   4. catalog sub_components suffixes uppercased when still empty
 *      (provenance → PROV/SUBMIT).
 * Family filter: when any token shares its letter-prefix with the component
 * id (cost → COST-*), keep only family matches — UNLESS that would empty the
 * set (context keeps CTX-* though CONTEXT ≠ CTX).
 */
const BACKTICKED_TOKEN_RE = /`([^`]+)`/g;
const PAREN_SLASH_GROUP_RE = /\(([A-Z]{2,}(?:\/[A-Z]{2,})+)\)/;
const BARE_CAPS_RE = /[A-Z][A-Z0-9]{1,9}/g;

function leadingAlphaRun(token: string): string {
  const m = /^[A-Z]+/.exec(token);
  return m ? m[0] : token.toUpperCase();
}

function extractRequirementIds(entry: CatalogEntry): string {
  const desc = entry.description ?? "";
  const found: string[] = [];

  // 1. Backticked ALL-CAPS tokens (no lowercase letters anywhere).
  for (const m of desc.matchAll(BACKTICKED_TOKEN_RE)) {
    const tok = m[1];
    if (tok !== undefined && /^[A-Z][A-Z0-9]*(?:[-/][A-Za-z0-9*.:]+)*$/.test(tok) && !/[a-z]/.test(tok)) {
      found.push(tok);
    }
  }

  // 2. Parenthesized slash-group of ALL-CAPS words.
  if (found.length === 0) {
    const m = PAREN_SLASH_GROUP_RE.exec(desc);
    const group = m?.[1];
    if (group !== undefined) found.push(group);
  }

  // 3. Bare ALL-CAPS words restricted to the first sentence.
  if (found.length === 0) {
    const firstSentence = desc.split(/(?<=\.)\s+/)[0] ?? desc;
    for (const m of firstSentence.matchAll(BARE_CAPS_RE)) {
      const tok = m[0];
      if (tok !== undefined) found.push(tok);
    }
  }

  // 4. Sub-component suffixes uppercased (provenance → PROV/SUBMIT).
  if (found.length === 0) {
    const subs = entry.sub_components ?? [];
    if (subs.length > 0) {
      return subs.map((s) => s.split("/").pop()!.toUpperCase()).join("/");
    }
  }

  // Family filter — keep id-prefix matches when present (unless emptying).
  const family = leadingAlphaRun((entry.id ?? "").toUpperCase());
  const familyMatches = found.filter((t) => leadingAlphaRun(t) === family);
  const unique = familyMatches.length > 0 ? familyMatches : found;
  return [...new Set(unique)].join("/");
}

/**
 * One-line role: the catalog description with the EXTRACTED requirement-id
 * occurrences removed (so the bullet does not repeat the tag), whitespace
 * collapsed, truncated at the first sentence boundary. The wording stays
 * verbatim catalog text — never rephrased (PROV-REU-01).
 *
 * Removal is conservative to avoid mangling catalog prose:
 * - backticked occurrences `TOK` always go;
 * - parenthesized groups that contain ONLY extracted tokens/slash-groups go;
 * - bare word occurrences stay (e.g. "3 distinct UI themes" keeps "UI";
 *   ideation's PIT/IDEA/RETRO remain readable in the role sentence).
 */
export function deriveRoleSentence(entry: CatalogEntry): string {
  let role = entry.description ?? "";
  const tokens = extractRequirementIds(entry).split("/");
  for (const tok of tokens) {
    role = role.replaceAll("`" + tok + "`", "");
  }
  if (tokens.length > 0) {
    const tokenSet = new Set(tokens);
    // Parenthesized groups whose segments are all extracted tokens.
    role = role.replace(/\(([^()]*)\)/g, (group, inner: string) => {
      const segments = inner.split("/").flatMap((s) => s.split(","));
      const cleaned = segments.map((s) => s.trim()).filter((s) => s.length > 0);
      if (cleaned.length > 0 && cleaned.every((s) => tokenSet.has(s))) return "";
      return group;
    });
  }
  // Tidy the seams left by removals.
  role = role
    .replace(/\(\s*\)/g, "")
    .replace(/\(\s*,\s*/g, "(")
    .replace(/,\s*\)/g, ")")
    .replace(/\s+([,.])/g, "$1")
    .replace(/^[^A-Za-z0-9`]+/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const firstSentenceEnd = role.search(/(?<=\.)\s/);
  if (firstSentenceEnd !== -1) role = role.slice(0, firstSentenceEnd + 1);
  return role.trim();
}

/** Catalog lookup: exact id first, then the top-level parent group for
 * sub-component manifest ids like media/stt (DP-G §6.17 granularity). */
export function lookupCatalogEntry(catalog: ComponentCatalog, id: string): CatalogEntry {
  const exact = catalog.components.find((c) => c.id === id);
  if (exact) return exact;
  const parent = catalog.components.find((c) => c.id === id.split("/")[0]);
  if (parent) return parent;
  throw new CatalogError(
    `component id "${id}" has no entry in contracts/component-catalog.json — update the catalog once per DP-G §6 (disclosure must not invent descriptions)`,
  );
}

//#endregion

//#region AI-tool log parsing (PROV-02, PROV-RES-01)

type ValidationResultShape = ReturnType<typeof validateAiLogEntry>;

/** Parse ai_tools.json bytes -> valid entries + skip warnings. A wholly
 * malformed payload (not JSON / not an array) warns and yields an EMPTY list —
 * a broken optional log must never block disclosure (PROV-RES-01). */
export function parseAiLog(aiLogBytes: string | null | undefined): {
  entries: AiToolLogEntry[];
  warnings: string[];
} {
  if (aiLogBytes == null || aiLogBytes.trim() === "") return { entries: [], warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(aiLogBytes);
  } catch {
    return { entries: [], warnings: ["warn: ai-log is not valid JSON — section omitted (PROV-RES-01)"] };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], warnings: ["warn: ai-log is not a JSON array — section omitted (PROV-RES-01)"] };
  }
  const entries: AiToolLogEntry[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const res = validateAiLogEntry(parsed[i]);
    if (res.valid) {
      entries.push(parsed[i] as AiToolLogEntry);
    } else {
      const msg = res.errors.map((e) => `${e.path} ${e.message}`).join("; ");
      warnings.push(`warn: ai-log entry ${i} skipped (malformed): ${msg} (GOV-RES-02)`);
    }
  }
  return { entries, warnings };
}

//#endregion

//#region Rendering (DP-J §3.1 Markdown shape — byte-stable)

/** Render one disclosure bullet: `**<id>** — <display_name> (<req ids>) — <role>` */
export function renderBullet(catalog: ComponentCatalog, id: string): string {
  const entry = lookupCatalogEntry(catalog, id);
  const reqIds = extractRequirementIds(entry);
  const role = deriveRoleSentence(entry);
  const reqPart = reqIds ? ` (\`${reqIds}\`)` : "";
  return `- **${id}** — ${entry.display_name}${reqPart} — ${role}`;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

//#endregion

//#region generateDisclosure (PROV-01..04)

/**
 * Parse + RES-04-validate manifest bytes. Throws ManifestValidationError
 * (path/message/code per ASM-RES-01) on parse or schema failure — the caller
 * must write nothing when this fires (accuracy over availability, DP-J §8).
 */
export function parseAndValidateManifest(manifestBytes: string | Uint8Array): AssemblyManifest {
  let parsed: unknown;
  try {
    const text =
      typeof manifestBytes === "string" ? manifestBytes : new TextDecoder().decode(manifestBytes);
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ManifestValidationError(
      "/",
      `manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      "parse",
    );
  }
  const result = validate(loadAssemblyManifestSchema(), parsed);
  if (!result.valid) {
    const first = result.errors[0];
    const detail = result.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new ManifestValidationError(first?.path ?? "/", detail, first?.code ?? "manifest_invalid");
  }
  return parsed as AssemblyManifest;
}

/**
 * PROV-01/02/03/04 — pure function of its inputs. Renders the disclosure
 * Markdown exactly per DP-J §3.1 and derives the PROV-05 architecture summary
 * from the same inputs so both artifacts share one source_manifest_hash.
 */
export function generateDisclosure(
  manifestBytes: string | Uint8Array,
  aiLogBytes: string | null,
  catalog: ComponentCatalog,
  config: DisclosureConfig = {},
  options: GenerateOptions = {},
): DisclosureResult {
  const sourceManifestHash = sha256Hex(manifestBytes);
  const manifest = parseAndValidateManifest(manifestBytes);

  const componentsReused = manifest.components.filter((c) => c.included).map((c) => c.id);
  const excluded = manifest.components.filter((c) => !c.included).map((c) => c.id);

  const { entries: aiLog, warnings } = parseAiLog(aiLogBytes);

  const shortShaLength = config.short_sha_length ?? 7;
  const shortSha = manifest.chassis_version.slice(0, shortShaLength);
  const generatedAt = options.now ?? new Date().toISOString();

  // Bullets — one per included component in MANIFEST order (PROV-04).
  const bullets = componentsReused.map((id) => renderBullet(catalog, id)).join("\n");

  const sections: string[] = [];
  sections.push("# Provenance & Disclosure");
  sections.push(
    "> Generated from `assembly.manifest.json` — do not hand-edit accuracy; polish wording only if needed. Verbatim reuse by DECKGEN-02 / SUBMIT-02 / FAQDEF-02 (contract 8).",
  );
  sections.push(
    `This project reuses **${componentsReused.length}** component(s) from the Hackathon Chassis Repository (\`${shortSha}\` / \`LICENSE: MIT\`).`,
  );
  sections.push(`## Reused components (${componentsReused.length})\n\n${bullets}`);

  if (config.include_excluded_footnote === true && excluded.length > 0) {
    const footnoteLines = excluded.map((id) => `- **${id}** — excluded per assembly.manifest.json.`);
    sections.push(`### Components not included\n\n${footnoteLines.join("\n")}`);
  }

  // AI assistance appears ONLY when the log is non-empty (PROV-RES-01).
  if (aiLog.length > 0) {
    const aiBullets = aiLog.map((e) => `- **${e.tool}** — ${e.scope}`).join("\n");
    sections.push(`## AI assistance\n\n${aiBullets}`);
  }

  const citeUrl = config.cite_chassis_url;
  const citeFirst = citeUrl
    ? `Cite the chassis repository (${citeUrl}) as prior scaffolding per \`XCUT-01\` / \`LICENSE\`.`
    : "Cite the chassis repository as prior scaffolding per `XCUT-01` / `LICENSE`.";
  sections.push(
    `## How to cite\n\n${citeFirst} Full disclosure source: \`assembly.manifest.json\` (\`manifest_version ${manifest.manifest_version}\`, \`chassis_version ${manifest.chassis_version}\`).`,
  );
  sections.push(`_Generated at ${generatedAt} from manifest hash ${sourceManifestHash}._`);

  const disclosureText = trimTrailingNewlines(sections.join("\n\n"));

  const architectureSummary = buildArchitectureSummary(manifest, catalog, config, options);
  const sourceAiLogHash = aiLogBytes != null && aiLogBytes.trim() !== "" ? sha256Hex(aiLogBytes) : null;

  return {
    disclosure_text: disclosureText,
    architecture_summary: architectureSummary.summary_text,
    components_reused: componentsReused,
    ai_tool_log: aiLog.length > 0 ? aiLog : null,
    source_manifest_hash: sourceManifestHash,
    source_ai_log_hash: sourceAiLogHash,
    generated_at: generatedAt,
    warnings,
  };
}

//#endregion
