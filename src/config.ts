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
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it in .env (see .env.example).`,
    );
  }
  return value;
}

export const config = {
  iec: {
    get baseUrl(): string {
      return process.env.IEC_BASE_URL ?? 'https://api.elections.org.za';
    },
    get version(): string {
      return process.env.IEC_API_VERSION ?? 'v1';
    },
    /** Only the ingestion CLI reads these. */
    get username(): string {
      return required('IEC_USERNAME');
    },
    get password(): string {
      return required('IEC_PASSWORD');
    },
    get concurrency(): number {
      return Number(process.env.IEC_CONCURRENCY ?? 4);
    },
  },

  db: {
    get connectionString(): string {
      return required('DATABASE_URL');
    },
  },

  scope: {
    get province(): string {
      return process.env.VENOM_PROVINCE ?? 'Gauteng';
    },
    // Exact aliases, pipe-separated. Never substring-matched: see
    // src/ingest/parties.ts for why that is not a style preference.
    get ourParty(): string {
      return process.env.VENOM_OUR_PARTY ?? 'MK|UMKHONTO WESIZWE|UMKHONTO WESIZWE PARTY';
    },
    get ourPartyIds(): string {
      return process.env.VENOM_OUR_PARTY_IDS ?? '';
    },
    get rivalParty(): string {
      return process.env.VENOM_RIVAL_PARTY ?? 'ANC|AFRICAN NATIONAL CONGRESS';
    },
    get rivalPartyIds(): string {
      return process.env.VENOM_RIVAL_PARTY_IDS ?? '';
    },
    get lgeBallot(): 'PR' | 'WARD' {
      return (process.env.VENOM_LGE_BALLOT ?? 'PR') as 'PR' | 'WARD';
    },
  },
};
