import { config } from '../config.js';
import type {
  TokenResponse, ElectoralEventType, ElectoralEvent,
  DelimitationProvince, DelimitationMunicipality, DelimitationWard,
  DelimitationVotingDistrict, LGEBallotResultsWard,
  NPEBallotResultsVotingDistrict, VotingStationDetails, ResultsProgress,
} from './types.js';

export class IECError extends Error {
  constructor(message: string, readonly status?: number, readonly endpoint?: string) {
    super(message);
    this.name = 'IECError';
  }
}

/** Caps in-flight requests. The Gauteng VD sweep is thousands of calls and
 *  the API is not ours to overload. */
class Gate {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class IECClient {
  private token: TokenResponse | undefined;
  private tokenExpiresAt = 0;
  private loginInFlight: Promise<void> | null = null;
  private readonly gate = new Gate(config.iec.concurrency);

  /** The URL a payload came from, recorded as provenance on every raw row. */
  endpointUrl(endpoint: string, params: Record<string, unknown> = {}): string {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const base = `${config.iec.baseUrl}/api/${config.iec.version}/${endpoint}`;
    return query ? `${base}?${query}` : base;
  }

  private async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const body = new URLSearchParams({
        grant_type: 'password',
        username: config.iec.username,
        password: config.iec.password,
      });
      const response = await fetch(`${config.iec.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        throw new IECError(
          `Login failed: ${response.status} ${response.statusText}`,
          response.status,
        );
      }
      this.token = (await response.json()) as TokenResponse;
      // Renew a minute early rather than racing the expiry.
      this.tokenExpiresAt = Date.now() + (this.token.expires_in - 60) * 1000;
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async ensureToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiresAt) await this.login();
    if (!this.token) throw new IECError('No token after login');
    return this.token.access_token;
  }

  /** GET with bounded concurrency, one re-auth on 401, and backoff on 429
   *  and 5xx. Four attempts, then the error is the caller's problem. */
  async get<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = this.endpointUrl(endpoint, params);
    return this.gate.run(async () => {
      let reAuthed = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const accessToken = await this.ensureToken();
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (response.status === 401 && !reAuthed) {
          this.token = undefined;
          reAuthed = true;
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 500;
          await sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          throw new IECError(
            `Request failed: ${response.status} ${response.statusText}`,
            response.status,
            url,
          );
        }

        const text = await response.text();
        if (!text) throw new IECError('Empty response body', response.status, url);
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new IECError('Invalid JSON response', response.status, url);
        }
      }
      throw new IECError('Exhausted retries', undefined, url);
    });
  }

  electoralEventTypes() {
    return this.get<ElectoralEventType[]>('ElectoralEvent');
  }

  electoralEvents(ElectoralEventTypeID: number) {
    return this.get<ElectoralEvent[]>('ElectoralEvent', { ElectoralEventTypeID });
  }

  provinces(ElectoralEventID: number) {
    return this.get<DelimitationProvince[]>('Delimitation', { ElectoralEventID });
  }

  municipalities(ElectoralEventID: number, ProvinceID: number) {
    return this.get<DelimitationMunicipality[]>('Delimitation', {
      ElectoralEventID, ProvinceID,
    });
  }

  wards(ElectoralEventID: number, ProvinceID: number, MunicipalityID: number) {
    return this.get<DelimitationWard[]>('Delimitation', {
      ElectoralEventID, ProvinceID, MunicipalityID,
    });
  }

  votingDistricts(
    ElectoralEventID: number, ProvinceID: number, MunicipalityID: number, WardID: number,
  ) {
    return this.get<DelimitationVotingDistrict[]>('Delimitation', {
      ElectoralEventID, ProvinceID, MunicipalityID, WardID,
    });
  }

  lgeResultsByWard(
    ElectoralEventID: number, ProvinceID: number, MunicipalityID: number, WardID: number,
  ) {
    return this.get<LGEBallotResultsWard>('LGEBallotResults', {
      ElectoralEventID, ProvinceID, MunicipalityID, WardID,
    });
  }

  /** National results stop at voting district: there is no ward endpoint.
   *  Ward-level 2024 figures are aggregated from these. */
  npeResultsByVotingDistrict(
    ElectoralEventID: number, ProvinceID: number, MunicipalityID: number, VDNumber: number,
  ) {
    return this.get<NPEBallotResultsVotingDistrict>('NPEBallotResults', {
      ElectoralEventID, ProvinceID, MunicipalityID, VDNumber,
    });
  }

  votingStationByVD(VDNumber: number) {
    return this.get<VotingStationDetails>('VotingStationDetails', { VDNumber });
  }

  resultsProgressByWard(
    ElectoralEventID: number, ProvinceID: number, MunicipalityID: number, WardID: number,
  ) {
    return this.get<ResultsProgress>('ResultsProgress', {
      ElectoralEventID, ProvinceID, MunicipalityID, WardID,
    });
  }
}
