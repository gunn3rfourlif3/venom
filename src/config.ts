/**
 * Configuration.
 *
 * Secrets are resolved LAZILY, on access, not at import. Eager validation
 * meant that importing config at all required every credential in the file,
 * so `create-user` and the API both refused to start without IEC API
 * credentials that neither of them uses — and `.env.example` ships those
 * keys blank, so following the README was enough to hit it.
 *
 * A value is required at the point something actually needs it.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it in .env (see .env.example).`,
    );
  }
  return value;
}

/* A SET-BUT-EMPTY VARIABLE IS NOT A VALUE, AND `??` DISAGREES.
 *
 * `??` falls back only on null and undefined. `IEC_BASE_URL=` in a .env file
 * is an empty STRING, which passes straight through every default below -
 * and `deploy/env.example` ships exactly these keys blank, so copying it is
 * enough to arm the trap. Observed on the production VPS: IEC_BASE_URL,
 * IEC_API_VERSION and IEC_CONCURRENCY were all present and all empty.
 *
 * The worst of the three was concurrency. `Number('')` is 0, not NaN, so the
 * request gate would have been built to admit zero concurrent calls: the
 * ingest would not have errored, it would have hung, silently, for as long
 * as anyone was willing to leave it. An overnight run producing nothing and
 * reporting nothing.
 *
 * Blank is treated as absent everywhere, which is what a blank line in a
 * config file means to the person who left it blank. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

export const config = {
  iec: {
    get baseUrl(): string {
      return optional('IEC_BASE_URL', 'https://api.elections.org.za');
    },
    get version(): string {
      return optional('IEC_API_VERSION', 'v1');
    },
    /** Only the ingestion CLI reads these. */
    get username(): string {
      return required('IEC_USERNAME');
    },
    get password(): string {
      return required('IEC_PASSWORD');
    },
    get concurrency(): number {
      // Guarded, not just defaulted: a non-numeric or zero value here does
      // not fail loudly, it stalls the gate. Anything that is not a positive
      // integer falls back rather than being believed.
      const parsed = Number(optional('IEC_CONCURRENCY', '4'));
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
    },
  },

  db: {
    get connectionString(): string {
      return required('DATABASE_URL');
    },
  },

  scope: {
    get province(): string {
      return optional('VENOM_PROVINCE', 'Gauteng');
    },
    // Exact aliases, pipe-separated. Never substring-matched: see
    // src/ingest/parties.ts for why that is not a style preference.
    get ourParty(): string {
      return optional('VENOM_OUR_PARTY', 'MK|UMKHONTO WESIZWE|UMKHONTO WESIZWE PARTY');
    },
    get ourPartyIds(): string {
      return optional('VENOM_OUR_PARTY_IDS', '');
    },
    get rivalParty(): string {
      return optional('VENOM_RIVAL_PARTY', 'ANC|AFRICAN NATIONAL CONGRESS');
    },
    get rivalPartyIds(): string {
      return optional('VENOM_RIVAL_PARTY_IDS', '');
    },
    get lgeBallot(): 'PR' | 'WARD' {
      return (optional('VENOM_LGE_BALLOT', 'PR') === 'WARD' ? 'WARD' : 'PR');
    },
  },
};
