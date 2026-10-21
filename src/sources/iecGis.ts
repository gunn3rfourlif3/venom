/* The IEC's GIS API.
 *
 *   https://api.elections.org.za/IECGIS/Help
 *
 * Open - no credentials, unlike the results API whose keys we are still
 * waiting on. It serves geography: municipalities, wards, voting districts
 * and the voting station inside each one.
 *
 * TWO THINGS WORTH KNOWING BEFORE READING THE CODE.
 *
 * It accepts MDB demarcation codes directly as MunicCode - 'JHB', 'GT421',
 * 'ETH', 'WC011' all work. That is the same key municipalmoney.gov.za uses,
 * so the two sources join without a translation table, which is luck rather
 * than design and worth not squandering.
 *
 * A ward holds several voting districts - eight in Johannesburg ward 1 - and
 * each district holds one voting station. So ward, VD and station are three
 * levels, not two. Published summaries that give 4,488 for both wards and
 * voting districts are conflating them: 4,488 wards over ~23,699 stations is
 * about five per ward.
 *
 * The API is a .NET service that returns a 500 with a stack trace rather than
 * a 4xx when something upstream is unhappy, and the coordinate-based lookups
 * currently throw NullReferenceException. Only the id-based endpoints are
 * used here, and 500s are treated as retryable rather than fatal.
 */

const BASE = 'https://api.elections.org.za/IECGIS/api';

export interface GisWard {
  wardId: string;
  wardNo: number | null;
  demarcationCode: string;
  municipalityName: string;
  province: string;
}

export interface GisStation {
  vdNumber: string;
  wardId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  streetName: string | null;
  suburb: string | null;
  town: string | null;
  stationType: string | null;
  openTime: string | null;
  closeTime: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "JHB - City of Johannesburg" carries the code we already have; the part
 *  worth keeping is the name after it. */
function cleanName(label: string, code: string): string {
  const prefix = `${code} - `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

const num = (v: unknown): number | null => {
  const parsed = Number(v);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
};

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

export class IecGisClient {
  constructor(
    private readonly pauseMs = 120,
    private readonly attempts = 4,
    private readonly userAgent = 'venom/0.1 (ward analytics; contact via repo)',
  ) {}

  private async get(path: string): Promise<unknown> {
    let lastError = '';
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const response = await fetch(`${BASE}/${path}`, {
          headers: { 'user-agent': this.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(45_000),
        });
        if (response.ok) {
          await sleep(this.pauseMs);
          return await response.json();
        }
        // 500 here usually means the upstream GIS store hiccupped rather than
        // that the request was wrong, so it is worth trying again.
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = (error as Error).message;
      }
      // Backing off rather than hammering: this is a public service and the
      // whole national walk is thousands of calls.
      await sleep(this.pauseMs * 4 * attempt);
    }
    throw new Error(lastError || 'request failed');
  }

  /** Every ward in a municipality, by demarcation code. */
  async wards(demarcationCode: string): Promise<GisWard[]> {
    const body = await this.get(
      `WardByMunicipality?MunicCode=${encodeURIComponent(demarcationCode)}&returnGeom=false`,
    ) as {
      Status?: string;
      WardDetail?: Array<{
        WardID?: string; WardNo?: string;
        MunicipalityCode?: string; Municipality?: string; Province?: string;
      }> | null;
    };

    if (body.Status === 'No Results' || !body.WardDetail) return [];

    const out: GisWard[] = [];
    for (const w of body.WardDetail) {
      const wardId = text(w.WardID);
      if (!wardId) continue;
      const code = text(w.MunicipalityCode) ?? demarcationCode;
      out.push({
        wardId,
        wardNo: w.WardNo === undefined ? null : num(w.WardNo),
        demarcationCode: code,
        municipalityName: cleanName(text(w.Municipality) ?? code, code),
        province: text(w.Province) ?? '',
      });
    }
    return out;
  }

  /** Every voting district in a ward, flattened to one row per station.
   *
   *  A district nominally holds one station, but the field is an array and is
   *  read as one: a district with no station is skipped rather than invented,
   *  and a district with two yields two. */
  async stations(wardId: string): Promise<GisStation[]> {
    const body = await this.get(
      `VotingDistrictByWard?WardID=${encodeURIComponent(wardId)}&returnGeom=false`,
    ) as {
      Status?: string;
      VotingDistrictsDetail?: Array<{
        VDNumber?: string; Ward?: string;
        VotingStation?: Array<{
          Name?: string; Latitude?: string; Longitude?: string;
          StreetName?: string; Suburb?: string; Town?: string;
          Type?: string; OpenTime?: string; CloseTime?: string;
        }> | null;
      }> | null;
    };

    if (body.Status === 'No Results' || !body.VotingDistrictsDetail) return [];

    const out: GisStation[] = [];
    for (const vd of body.VotingDistrictsDetail) {
      const vdNumber = text(vd.VDNumber);
      if (!vdNumber) continue;
      for (const s of vd.VotingStation ?? []) {
        const name = text(s.Name);
        // No name means nothing operationally usable. Recorded as absent
        // rather than filed as "Unknown station", which would look like data.
        if (!name) continue;
        out.push({
          vdNumber,
          wardId: text(vd.Ward) ?? wardId,
          name,
          latitude: num(s.Latitude),
          longitude: num(s.Longitude),
          streetName: text(s.StreetName),
          suburb: text(s.Suburb),
          town: text(s.Town),
          stationType: text(s.Type),
          openTime: text(s.OpenTime),
          closeTime: text(s.CloseTime),
        });
      }
    }
    return out;
  }
}

export const IEC_GIS_URL = 'https://api.elections.org.za/IECGIS/Help';
