import { config } from '../config.js';
import { withTransaction, pool } from '../db.js';
import { latestPayloads, markPromoted } from './fetch.js';
import { Source } from './sources.js';
import { parseIdentity, matches, MatchCounter } from './parties.js';
import type {
  DelimitationMunicipality, DelimitationWard, ElectoralEvent,
  LGEBallotResultsWard, NPEBallotResultsVotingDistrict, VotingStationDetails,
} from '../iec/types.js';

export type EventKind = 'LGE' | 'NPE' | 'OTHER';

export interface EventMeta {
  id: number;
  kind: EventKind;
  year: number | null;
  description: string;
}

interface EventTypePayload {
  typeId: number;
  typeDescription: string;
  events: ElectoralEvent[];
}

/** The IEC's own type descriptions decide this, not a hardcoded event id:
 *  event ids change every cycle, the words do not. */
export function classify(typeDescription: string): EventKind {
  if (/local|municipal/i.test(typeDescription)) return 'LGE';
  if (/national|provincial/i.test(typeDescription)) return 'NPE';
  return 'OTHER';
}

export function yearOf(description: string): number | null {
  const match = description.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export async function electoralEventMeta(): Promise<Map<number, EventMeta>> {
  const rows = await latestPayloads<EventTypePayload>(Source.ElectoralEvents);
  const meta = new Map<number, EventMeta>();
  for (const row of rows) {
    const kind = classify(row.payload.typeDescription);
    for (const event of row.payload.events ?? []) {
      meta.set(event.ID, {
        id: event.ID,
        kind,
        year: yearOf(event.Description),
        description: event.Description,
      });
    }
  }
  return meta;
}

function splitKey(key: string | null): string[] {
  return key ? key.split(':') : [];
}

interface WardAccumulator {
  wardId: string;
  municipalityId: number | null;
  municipality: string | null;
  provinceId: number | null;
  registeredVoters: number | null;
  registeredVotersYear: number;
  t2021Anc: number | null;
  t2021Turnout: number | null;
  t2024Mkp: number | null;
  t2024Anc: number | null;
  t2024Turnout: number | null;
  peakLge: number | null;
  peakAll: number | null;
  sourceUrl: string | null;
  fetchedAt: Date | null;
}

function ensure(map: Map<string, WardAccumulator>, wardId: string): WardAccumulator {
  let acc = map.get(wardId);
  if (!acc) {
    acc = {
      wardId, municipalityId: null, municipality: null, provinceId: null,
      registeredVoters: null, registeredVotersYear: -1,
      t2021Anc: null, t2021Turnout: null,
      t2024Mkp: null, t2024Anc: null, t2024Turnout: null,
      peakLge: null, peakAll: null, sourceUrl: null, fetchedAt: null,
    };
    map.set(wardId, acc);
  }
  return acc;
}

const higher = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** Build the ward rows from everything in staging. Pure: it reads staging
 *  and returns rows, so the arithmetic can be tested without a write. */
export async function buildWardRows(): Promise<WardAccumulator[]> {
  const events = await electoralEventMeta();
  const wards = new Map<string, WardAccumulator>();
  const ours = parseIdentity(config.scope.ourParty, config.scope.ourPartyIds);
  const rival = parseIdentity(config.scope.rivalParty, config.scope.rivalPartyIds);
  const counter = new MatchCounter();

  // delimitation: which wards exist, and in which municipality
  const municipalities = new Map<number, string>();
  for (const row of await latestPayloads<DelimitationMunicipality[]>(Source.Municipalities)) {
    for (const m of row.payload ?? []) municipalities.set(m.MunicipalityID, m.Municipality);
  }
  for (const row of await latestPayloads<DelimitationWard[]>(Source.Wards)) {
    for (const w of row.payload ?? []) {
      const acc = ensure(wards, String(w.WardID));
      acc.municipalityId = w.MunicipalityID;
      acc.municipality = municipalities.get(w.MunicipalityID) ?? acc.municipality;
      acc.provinceId = w.ProvinceID;
    }
  }

  // LGE ward results: party support from the configured ballot, plus turnout
  const ballot = config.scope.lgeBallot;
  for (const row of await latestPayloads<LGEBallotResultsWard>(Source.LGEWardResults)) {
    const [eventIdRaw, wardIdRaw] = splitKey(row.sourceKey);
    if (!eventIdRaw || !wardIdRaw) continue;
    const meta = events.get(Number(eventIdRaw));
    const acc = ensure(wards, wardIdRaw);
    const result = row.payload;
    if (!result) continue;

    acc.sourceUrl = row.sourceUrl;
    acc.fetchedAt = row.fetchedAt;
    acc.peakLge = higher(acc.peakLge, result.PercVoterTurnout ?? null);
    acc.peakAll = higher(acc.peakAll, result.PercVoterTurnout ?? null);

    const year = meta?.year ?? null;
    if (year !== null && year > acc.registeredVotersYear && result.RegisteredVoters) {
      acc.registeredVoters = result.RegisteredVoters;
      acc.registeredVotersYear = year;
    }

    if (year === 2021) {
      // the local baseline every turnout shortfall is measured against
      acc.t2021Turnout = result.PercVoterTurnout ?? null;
      let total = 0;
      for (const party of result.PartyBallotResults ?? []) {
        const hit = matches(party, rival);
        counter.record('rival', hit, party);
        if (hit) total += (ballot === 'PR' ? party.PR_ValidVotes : party.Ward_ValidVotes) ?? 0;
      }
      acc.t2021Anc = total;
    }
  }

  // NPE: no ward endpoint exists, so ward figures are summed from the
  // voting districts the delimitation says belong to that ward.
  interface NpeTally {
    registered: number; cast: number; ours: number; rival: number;
  }
  const npeByWardYear = new Map<string, NpeTally>();

  for (const row of await latestPayloads<NPEBallotResultsVotingDistrict>(Source.NPEVDResults)) {
    const [eventIdRaw, , wardIdRaw] = splitKey(row.sourceKey);
    if (!eventIdRaw || !wardIdRaw) continue;
    const meta = events.get(Number(eventIdRaw));
    const year = meta?.year;
    if (!year) continue;
    const result = row.payload;
    if (!result) continue;

    const key = `${wardIdRaw}:${year}`;
    const tally = npeByWardYear.get(key) ?? { registered: 0, cast: 0, ours: 0, rival: 0 };
    tally.registered += result.RegisteredVoters ?? 0;
    tally.cast += result.TotalVotesCast ?? 0;
    for (const party of result.PartyBallotResults ?? []) {
      const isOurs = matches(party, ours);
      const isRival = matches(party, rival);
      counter.record('ours', isOurs, party);
      counter.record('rival', isRival, party);
      if (isOurs) tally.ours += party.ValidVotes ?? 0;
      if (isRival) tally.rival += party.ValidVotes ?? 0;
    }
    npeByWardYear.set(key, tally);
  }

  for (const [key, tally] of npeByWardYear) {
    const [wardId, yearRaw] = key.split(':');
    if (!wardId || !yearRaw) continue;
    const year = Number(yearRaw);
    const acc = ensure(wards, wardId);
    const turnout = tally.registered > 0
      ? Number(((tally.cast / tally.registered) * 100).toFixed(2))
      : null;

    acc.peakAll = higher(acc.peakAll, turnout);
    if (year > acc.registeredVotersYear && tally.registered > 0) {
      acc.registeredVoters = tally.registered;
      acc.registeredVotersYear = year;
    }
    if (year === 2024) {
      acc.t2024Mkp = tally.ours;
      acc.t2024Anc = tally.rival;
      acc.t2024Turnout = turnout;
    }
  }

  // A party configuration that matches nothing would write zero votes for
  // every ward and look entirely plausible. Fail instead.
  counter.assertAllMatched(['ours', 'rival']);

  return [...wards.values()];
}

/**
 * Upsert wards. Only scraped columns are written: zone, candidate_status and
 * the m1-m5 capacity fields are campaign-entered and are never touched here,
 * or an ingest run would silently erase what the organisers reported.
 */
export async function promoteWards(): Promise<{ wards: number }> {
  const rows = await buildWardRows();
  if (rows.length === 0) return { wards: 0 };

  await withTransaction(async (client) => {
    for (const w of rows) {
      await client.query(
        `INSERT INTO ward (
           ward_id, municipality, province, registered_voters,
           t2021_anc, t2021_turnout, t2024_mkp, t2024_anc, t2024_turnout,
           peak_turnout_lge_pct, peak_turnout_all_pct,
           source, source_fetched_at, source_url)
         VALUES ($1,$2,$3,COALESCE($4,0),$5,$6,$7,$8,$9,$10,$11,'iec',$12,$13)
         ON CONFLICT (ward_id) DO UPDATE SET
           municipality         = COALESCE(EXCLUDED.municipality, ward.municipality),
           province             = COALESCE(EXCLUDED.province, ward.province),
           registered_voters    = COALESCE(NULLIF(EXCLUDED.registered_voters,0), ward.registered_voters),
           t2021_anc            = COALESCE(EXCLUDED.t2021_anc, ward.t2021_anc),
           t2021_turnout        = COALESCE(EXCLUDED.t2021_turnout, ward.t2021_turnout),
           t2024_mkp            = COALESCE(EXCLUDED.t2024_mkp, ward.t2024_mkp),
           t2024_anc            = COALESCE(EXCLUDED.t2024_anc, ward.t2024_anc),
           t2024_turnout        = COALESCE(EXCLUDED.t2024_turnout, ward.t2024_turnout),
           peak_turnout_lge_pct = COALESCE(EXCLUDED.peak_turnout_lge_pct, ward.peak_turnout_lge_pct),
           peak_turnout_all_pct = COALESCE(EXCLUDED.peak_turnout_all_pct, ward.peak_turnout_all_pct),
           source               = EXCLUDED.source,
           source_fetched_at    = EXCLUDED.source_fetched_at,
           source_url           = EXCLUDED.source_url`,
        [
          w.wardId, w.municipality, config.scope.province, w.registeredVoters,
          w.t2021Anc, w.t2021Turnout, w.t2024Mkp, w.t2024Anc, w.t2024Turnout,
          w.peakLge, w.peakAll, w.fetchedAt, w.sourceUrl,
        ],
      );

      // every ward is also a location, so stock can be held against it
      await client.query(
        `INSERT INTO location (location_id, kind, name, ward_id)
         VALUES ($1, 'ward', $2, $1)
         ON CONFLICT (location_id) DO UPDATE SET name = EXCLUDED.name`,
        [w.wardId, `Ward ${w.wardId}`],
      );
    }
  });

  await markPromoted(Source.Wards);
  await markPromoted(Source.LGEWardResults);
  await markPromoted(Source.NPEVDResults);
  return { wards: rows.length };
}

/** Station list and coordinates are scraped; our_people, hours_coverage,
 *  anc_expected and pledges are reported by people and are never written. */
export async function promoteStations(): Promise<{ stations: number }> {
  const rows = await latestPayloads<VotingStationDetails>(Source.VotingStation);
  let written = 0;

  await withTransaction(async (client) => {
    for (const row of rows) {
      const location = row.payload?.Location;
      const vd = location?.VDNumber ?? (row.sourceKey ? Number(row.sourceKey) : null);
      const wardId = location?.WardID;
      if (!vd || !wardId) continue;

      const exists = await client.query('SELECT 1 FROM ward WHERE ward_id = $1', [String(wardId)]);
      if (exists.rowCount === 0) continue; // outside scope, skip rather than fail the run

      await client.query(
        `INSERT INTO station (
           station_id, ward_id, name, latitude, longitude,
           source, source_fetched_at, source_url)
         VALUES ($1,$2,$3,$4,$5,'iec',$6,$7)
         ON CONFLICT (station_id) DO UPDATE SET
           ward_id           = EXCLUDED.ward_id,
           name              = EXCLUDED.name,
           latitude          = COALESCE(EXCLUDED.latitude, station.latitude),
           longitude         = COALESCE(EXCLUDED.longitude, station.longitude),
           source            = EXCLUDED.source,
           source_fetched_at = EXCLUDED.source_fetched_at,
           source_url        = EXCLUDED.source_url`,
        [
          String(vd), String(wardId), row.payload?.Name ?? `VD ${vd}`,
          location?.Latitude ?? null, location?.Longitude ?? null,
          row.fetchedAt, row.sourceUrl,
        ],
      );
      written += 1;
    }
  });

  await markPromoted(Source.VotingStation);
  return { stations: written };
}

/** Refresh the extract and tell any listener. CONCURRENTLY needs the unique
 *  index on ward_id, and needs the view to have been populated once. */
export async function refreshExtract(): Promise<void> {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_campaign_extract');
  } catch {
    await pool.query('REFRESH MATERIALIZED VIEW mv_campaign_extract');
  }
  await pool.query("NOTIFY extract_stale, 'promoted'");
}
