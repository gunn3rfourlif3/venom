/** Source names recorded on every raw.fetch row. One per endpoint shape, so
 *  v_ingest_health reports staleness per feed rather than in aggregate. */
export const Source = {
  ElectoralEvents: 'iec.electoral_events',
  Provinces: 'iec.delimitation.province',
  Municipalities: 'iec.delimitation.municipality',
  Wards: 'iec.delimitation.ward',
  VotingDistricts: 'iec.delimitation.vd',
  LGEWardResults: 'iec.lge.ward_results',
  NPEVDResults: 'iec.npe.vd_results',
  VotingStation: 'iec.voting_station',
} as const;

export type SourceName = (typeof Source)[keyof typeof Source];
