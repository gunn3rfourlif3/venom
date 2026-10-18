function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  iec: {
    baseUrl: process.env.IEC_BASE_URL ?? 'https://api.elections.org.za',
    version: process.env.IEC_API_VERSION ?? 'v1',
    username: required('IEC_USERNAME'),
    password: required('IEC_PASSWORD'),
    concurrency: Number(process.env.IEC_CONCURRENCY ?? 4),
  },
  db: {
    connectionString: required('DATABASE_URL'),
  },
  scope: {
    province: process.env.VENOM_PROVINCE ?? 'Gauteng',
    // Exact aliases, pipe-separated. Never substring-matched: see
    // src/ingest/parties.ts for why that is not a style preference.
    ourParty: process.env.VENOM_OUR_PARTY ?? 'MK|UMKHONTO WESIZWE|UMKHONTO WESIZWE PARTY',
    ourPartyIds: process.env.VENOM_OUR_PARTY_IDS ?? '',
    rivalParty: process.env.VENOM_RIVAL_PARTY ?? 'ANC|AFRICAN NATIONAL CONGRESS',
    rivalPartyIds: process.env.VENOM_RIVAL_PARTY_IDS ?? '',
    lgeBallot: (process.env.VENOM_LGE_BALLOT ?? 'PR') as 'PR' | 'WARD',
  },
} as const;
