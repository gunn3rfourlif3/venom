// Response shapes for the endpoints Venom uses. Field names are the IEC's
// own PascalCase, left as returned so a payload can be compared against the
// API docs without translation.

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}

export interface ElectoralEventType {
  ID: number;
  Description: string;
}

export interface ElectoralEvent {
  ID: number;
  Description: string;
  IsActive: boolean;
}

export interface DelimitationProvince {
  ProvinceID: number;
  Province: string;
}

export interface DelimitationMunicipality {
  ProvinceID: number;
  MunicipalityID: number;
  Municipality: string;
  MunicTypeID: number;
}

export interface DelimitationWard {
  ProvinceID: number;
  MunicipalityID: number;
  WardID: number;
}

export interface DelimitationVotingDistrict extends DelimitationWard {
  VDNumber: number;
}

export interface LGEPartyBallotResult {
  ID: number;
  Name: string;
  Ward_ValidVotes: number;
  PR_ValidVotes: number;
  DC40Perc_ValidVotes: number;
  TotalValidVotes: number;
  PercOfVotes: number;
}

export interface LGEBallotResults {
  ElectoralEventID: number;
  ElectoralEvent: string;
  RegisteredVoters: number;
  SpoiltVotes: number;
  SpecialVotes: number;
  PercVoterTurnout: number;
  TotalVotesCast: number;
  TotalValidVotes: number;
  VDCount: number;
  VDWithResultsCaptured: number;
  bResultsComplete: boolean;
  PartyBallotResults: LGEPartyBallotResult[];
}

export interface LGEBallotResultsWard extends LGEBallotResults {
  ProvinceID: number;
  Province: string;
  MunicipalityID: number;
  Municipality: string;
  WardID: number;
}

export interface NPEPartyBallotResult {
  ID: number;
  Name: string;
  ValidVotes: number;
  PercOfVotes: number;
  PartyAbbr: string;
}

export interface NPEBallotResultsVotingDistrict {
  ElectoralEventID: number;
  ElectoralEvent: string;
  ProvinceID: number;
  Province: string;
  MunicipalityID: number;
  Municipality: string;
  VDNumber: number;
  RegisteredVoters: number;
  SpoiltVotes: number;
  Section24AVotes: number;
  SpecialVotes: number;
  PercVoterTurnout: number;
  TotalVotesCast: number;
  TotalValidVotes: number;
  bResultsComplete: boolean;
  PartyBallotResults: NPEPartyBallotResult[];
}

export interface VotingStationDetails {
  Name?: string;
  Location?: {
    Latitude?: number;
    Longitude?: number;
    VDNumber?: number;
    WardID?: number;
    MunicipalityID?: number;
    ProvinceID?: number;
    VDAddress?: string;
  };
}

export interface ResultsProgress {
  VDResultsIn: number;
  VDTotal: number;
  SeatCalculationCompleted: boolean;
}
