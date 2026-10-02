/**
 * Config binding: map a B&E tournament/division ↔ a PB.com event `eid` / division.
 *
 * This is DECLARATIVE (a JSON config file today; a `pbcom_event_bindings` table
 * is the documented production seam — see DESIGN.md). Nothing about a specific
 * tournament or eid is hardcoded in the driver: the binding is data.
 *
 * Division mapping is by LABEL by default — the import (#981) already established
 * that `events.source_division_label` IS the division's identity in PB.com, so no
 * fuzzy matching is needed. A binding may pin an explicit `pbcomDivisionId` once the
 * trace reveals PB.com's internal division handle, but it is optional.
 */
import { readFileSync } from "node:fs";
import { divisionKeyOf } from "./push/plan.js";
import type {
  BandeDivision,
  BindingConfig,
  PbcomDivisionBinding,
  PbcomEventBinding,
} from "./types.js";

export class BindingError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BindingError";
  }
}

/** Parse + validate a binding config object (already JSON-parsed). */
export function parseBinding(raw: unknown): BindingConfig {
  if (!raw || typeof raw !== "object") throw new BindingError("binding config is not an object");
  const cfg = raw as Partial<BindingConfig>;
  if (cfg.version !== 1) throw new BindingError(`unsupported binding version: ${String(cfg.version)}`);
  if (!Array.isArray(cfg.events)) throw new BindingError("binding.events must be an array");
  const seen = new Set<string>();
  for (const e of cfg.events) {
    if (!e || typeof e.tournamentId !== "string" || !e.tournamentId.trim()) {
      throw new BindingError("each binding needs a non-empty tournamentId");
    }
    if (typeof e.pbcomEid !== "string" || !e.pbcomEid.trim()) {
      throw new BindingError(`binding for tournament ${e.tournamentId} needs a non-empty pbcomEid`);
    }
    if (seen.has(e.tournamentId)) {
      throw new BindingError(`duplicate binding for tournament ${e.tournamentId}`);
    }
    seen.add(e.tournamentId);
  }
  return cfg as BindingConfig;
}

/** Load + validate the binding config from disk. */
export function loadBinding(path: string): BindingConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BindingError(`cannot read binding config at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new BindingError(`binding config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseBinding(json);
}

/** Resolve the PB.com event binding for a B&E tournament. Throws if unmapped. */
export function resolveEventBinding(cfg: BindingConfig, tournamentId: string): PbcomEventBinding {
  const found = cfg.events.find((e) => e.tournamentId === tournamentId);
  if (!found) {
    throw new BindingError(
      `no PB.com binding for tournament ${tournamentId} — add it to the binding config before pushing`,
    );
  }
  return found;
}

/**
 * Resolve how a B&E division maps onto PB.com within its event binding:
 *   - it must be a pbcom-sourced division (has source_division_label), and
 *   - either an explicit pbcomDivisionId override, or its label as the handle.
 */
export interface ResolvedDivisionTarget {
  pbcomEid: string;
  /** PB.com division label (the default handle). */
  divisionLabel: string;
  /** Explicit PB.com division id when pinned in the binding; else null. */
  pbcomDivisionId: string | null;
}

export function resolveDivisionTarget(
  binding: PbcomEventBinding,
  division: BandeDivision,
): ResolvedDivisionTarget {
  if (division.sourceSystem !== "pbcom" || !division.sourceDivisionLabel) {
    throw new BindingError(
      `division ${division.eventId} (${division.name}) is not PB.com-sourced — nothing to push back`,
    );
  }
  const label = division.sourceDivisionLabel;
  const override: PbcomDivisionBinding | undefined = binding.divisions?.find(
    (d) => divisionKeyOf(d.sourceDivisionLabel) === divisionKeyOf(label),
  );
  return {
    pbcomEid: binding.pbcomEid,
    divisionLabel: label,
    pbcomDivisionId: override?.pbcomDivisionId ?? null,
  };
}
