/**
 * Party matching.
 *
 * NEVER substring-match a party name. "DEMOCRATIC ALLIANCE" contains "ANC"
 * (alli-ANC-e) while "AFRICAN NATIONAL CONGRESS" does not, so a substring
 * match silently reads the wrong party's votes into swing_index. That bug is
 * invisible downstream: every figure still looks plausible.
 *
 * Match on the IEC's numeric party ID where it is known, and otherwise on an
 * exact, normalised equality against the abbreviation or the full name.
 */

export interface PartyIdentity {
  /** IEC party IDs. The most reliable key; stable across events. */
  ids: number[];
  /** Exact abbreviations or full names, pipe-separated in config. */
  aliases: string[];
}

export function normalise(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

export function parseIdentity(aliasSpec: string, idSpec: string): PartyIdentity {
  return {
    ids: idSpec.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
    aliases: aliasSpec.split('|').map(normalise).filter(Boolean),
  };
}

export interface PartyLike {
  ID?: number;
  Name?: string;
  PartyAbbr?: string;
}

export function matches(party: PartyLike, identity: PartyIdentity): boolean {
  if (party.ID !== undefined && identity.ids.includes(party.ID)) return true;
  if (party.PartyAbbr && identity.aliases.includes(normalise(party.PartyAbbr))) return true;
  if (party.Name && identity.aliases.includes(normalise(party.Name))) return true;
  return false;
}

/** Tracks whether a party was ever found, so a configuration that matches
 *  nothing fails loudly instead of writing zeroes everywhere. */
export class MatchCounter {
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();

  record(label: string, matched: boolean, party?: PartyLike): void {
    this.counts.set(label, (this.counts.get(label) ?? 0) + (matched ? 1 : 0));
    if (party?.Name) this.seen.add(normalise(party.Name));
    if (party?.PartyAbbr) this.seen.add(normalise(party.PartyAbbr));
  }

  count(label: string): number {
    return this.counts.get(label) ?? 0;
  }

  /** Throws if a configured party was never matched anywhere. */
  assertAllMatched(labels: string[]): void {
    const missing = labels.filter((l) => this.count(l) === 0);
    if (missing.length === 0) return;
    const sample = [...this.seen].sort().slice(0, 25).join(', ');
    throw new Error(
      `Party configuration matched nothing for: ${missing.join(', ')}. ` +
      `Promotion aborted rather than writing zero votes for every ward. ` +
      `Party names actually returned include: ${sample}`,
    );
  }
}
