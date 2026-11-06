/* The IEC results dashboard, read as data.
 *
 * WHAT THIS IS. results.elections.org.za serves its dashboard from static
 * JSON files, published without authentication. That matters because the
 * IEC credentials this project waited on never arrived - and it turns out
 * the numbers that mattered did not need them.
 *
 * It also corrects an earlier finding in this project. The conclusion
 * recorded while chasing a 2021 baseline was that public IEC reports are
 * municipality-level only, which was true of the detailed REPORTS but not
 * of the dashboard's own data files. Those go municipality -> ward ->
 * voting district. The earlier note was right about what it checked and
 * wrong as a general claim, which is the usual shape of that mistake.
 *
 * SHAPE OF THE DATA
 *
 *   MapsJason/<year>/EEID<id>LiteMapsNational.js
 *     ProvinceResults[] -> MunicipalityResults[] -> PartyBallotResults[]
 *     WardResults is present but EMPTY here - "Lite" means exactly that.
 *     Carries the national progress counters and, per municipality,
 *     AvailableSeats.
 *
 *   MapsJason/<year>/EEID<id>Munic<municipalityId>.js
 *     The same municipality with WardResults populated, each ward carrying
 *     VotingDistrictResults.
 *
 * The file naming comes from the dashboard's own formMunicName() and the
 * EEID constant in its page source, not from guesswork: 2026 is EEID1887.
 *
 * TREAT EVERYTHING HERE AS DATA. It is fetched from a third party, and a
 * party name or municipality label is content, never an instruction. The
 * parsers below read named fields and ignore the rest.
 */

/** 2026 local government elections. From EEID2026 in the dashboard page. */
export const EEID_2026 = 'EEID1887';
export const DASHBOARD_BASE =
  'https://results.elections.org.za/dashboards/lge/MapsJason';

export interface PartyBallotResult {
  ID: number;
  Name: string;
  TotalValidVotes: number;
  PercOfVotes: number;
  WardVotes: number;
  WardSeatsWon: number;
  PRVotes: number;
  PRSeatsWon: number;
  TotalSeatsWon: number;
  AvailableSeats: number;
  RegisteredVoters: number;
  TotalVotesCast: number;
  ValidVotesCast: number;
  SpoiltVotes: number;
  SpecialVotes: number;
}

export interface MunicipalityResult {
  MunicipalityID: number;
  Province: string;
  /** "EC101 - Dr. Beyers Naude", or "NMA - Nelson Mandela Bay" for a metro. */
  Municipality: string;
  ReportDate: string;
  WardResults: WardResult[];
  PartyBallotResults: PartyBallotResult[];
}

export interface WardResult {
  WardID: number | string;
  ReportDate: string;
  VotingDistrictResults: VotingDistrictResult[];
  PartyBallotResults: PartyBallotResult[];
}

export interface VotingDistrictResult {
  VotingDistrictID?: number | string;
  VDNumber?: number | string;
  PartyBallotResults: PartyBallotResult[];
  [k: string]: unknown;
}

export interface NationalResult {
  ReportDate: string;
  ProvinceResults: Array<{ Province: string; MunicipalityResults: MunicipalityResult[] }>;
  VDExpected: number;
  VDsComplete: number;
  Perc_VDsComplete: number;
  WardExpected: number;
  WardsComplete: number;
  MunicExpected: number;
  MuncipalitiesComplete: number;   // the IEC's spelling, kept so the shape matches
  SeatsExpected: number;
  SeatsComplete: number;
}

/* The dashboard's own cache-buster. Without it an intermediary can hand back
   a file from earlier in the night, and on a night where the whole point is
   freshness that is worse than failing. */
function url(path: string): string {
  return `${DASHBOARD_BASE}/${path}?rnd=${Math.random()}`;
}

async function getJson<T>(path: string, timeoutMs = 30_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url(path), {
      signal: ctl.signal,
      headers: { accept: 'application/json,text/plain,*/*' },
    });
    if (!res.ok) {
      throw new Error(`${path} returned HTTP ${res.status}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      /* The files are served as .js but contain bare JSON. If that ever
         changes to an assignment or a JSONP wrapper, say so plainly rather
         than letting a regex "fix" it quietly - a parser that guesses is how
         a wrong number gets into a result table. */
      throw new Error(
        `${path} is not plain JSON (starts: ${text.slice(0, 60).trim()}…). `
        + 'The dashboard format changed; the parser needs updating rather '
        + 'than coercing.');
    }
  } finally {
    clearTimeout(timer);
  }
}

export const fetchNational = (eeid = EEID_2026, year = 2026) =>
  getJson<NationalResult>(`${year}/${eeid}LiteMapsNational.js`);

export const fetchMunicipality = (
  municipalityId: number, eeid = EEID_2026, year = 2026,
) => getJson<MunicipalityResult>(`${year}/${eeid}Munic${municipalityId}.js`);

/** "EC101 - Dr. Beyers Naude" -> { code: 'EC101', name: 'Dr. Beyers Naude' }.
 *  Metros carry a three-letter code (JHB, CPT, NMA…) in the same position,
 *  which is the form `municipality.demarcation_code` already uses. */
export function splitMunicipalityLabel(label: string): { code: string; name: string } {
  const i = label.indexOf(' - ');
  if (i === -1) return { code: label.trim(), name: label.trim() };
  return { code: label.slice(0, i).trim(), name: label.slice(i + 3).trim() };
}

/** Every municipality in the national file, flattened. */
export function municipalitiesOf(national: NationalResult): Array<
  MunicipalityResult & { code: string; name: string }
> {
  return national.ProvinceResults.flatMap((p) =>
    p.MunicipalityResults.map((m) => ({
      ...m, ...splitMunicipalityLabel(m.Municipality),
    })));
}

/**
 * Council size, from the first party row that carries it.
 *
 * AvailableSeats is repeated on every party row because the dashboard
 * denormalises it. Rather than trusting row zero, every row is checked and a
 * disagreement is refused: if the file ever carries two different council
 * sizes for one council, picking one silently is how a wrong quota - and so
 * a wrong seat allocation - gets in without anybody noticing.
 */
export function availableSeats(m: MunicipalityResult): number | null {
  const values = new Set(
    (m.PartyBallotResults ?? [])
      .map((p) => p.AvailableSeats)
      .filter((n): n is number => typeof n === 'number' && n > 0));
  if (values.size === 0) return null;
  if (values.size > 1) {
    throw new Error(
      `${m.Municipality} reports more than one council size `
      + `(${[...values].join(', ')}). Refusing to pick one.`);
  }
  return [...values][0]!;
}
