/** Stages realistic IEC payloads and promotes them, with no network. */
import { pool } from '../db.js';
import { recordFetch } from '../ingest/fetch.js';
import { Source } from '../ingest/sources.js';
import { promoteWards, promoteStations, refreshExtract } from '../ingest/promote.js';

const NPE = 1116, LGE = 1053, PROV = 3, MUNIC = 79800;
const W1 = 79800001, W2 = 79800002;

async function main() {
  await recordFetch(Source.ElectoralEvents, '1', 'u',
    { typeId: 1, typeDescription: 'National and Provincial Elections',
      events: [{ ID: NPE, Description: '2024 National and Provincial Elections', IsActive: false }] });
  await recordFetch(Source.ElectoralEvents, '2', 'u',
    { typeId: 2, typeDescription: 'Local Government Elections',
      events: [{ ID: LGE, Description: '2021 Municipal Elections', IsActive: false }] });

  await recordFetch(Source.Municipalities, String(PROV), 'u',
    [{ ProvinceID: PROV, MunicipalityID: MUNIC, Municipality: 'City of Johannesburg', MunicTypeID: 1 }]);
  await recordFetch(Source.Wards, String(MUNIC), 'u',
    [{ ProvinceID: PROV, MunicipalityID: MUNIC, WardID: W1 },
     { ProvinceID: PROV, MunicipalityID: MUNIC, WardID: W2 }]);

  // LGE 2021: ward 1 turnout 58%, ANC PR 6000. Ward 2 turnout 61%, ANC PR 2000.
  await recordFetch(Source.LGEWardResults, `${LGE}:${W1}`, 'u',
    { ElectoralEventID: LGE, RegisteredVoters: 20000, PercVoterTurnout: 58.0,
      PartyBallotResults: [
        { ID: 1, Name: 'AFRICAN NATIONAL CONGRESS', PR_ValidVotes: 6000, Ward_ValidVotes: 6200, TotalValidVotes: 12200, PercOfVotes: 52 },
        { ID: 2, Name: 'DEMOCRATIC ALLIANCE', PR_ValidVotes: 4000, Ward_ValidVotes: 3900, TotalValidVotes: 7900, PercOfVotes: 34 }] });
  await recordFetch(Source.LGEWardResults, `${LGE}:${W2}`, 'u',
    { ElectoralEventID: LGE, RegisteredVoters: 15000, PercVoterTurnout: 61.0,
      PartyBallotResults: [
        { ID: 1, Name: 'AFRICAN NATIONAL CONGRESS', PR_ValidVotes: 2000, Ward_ValidVotes: 2100, TotalValidVotes: 4100, PercOfVotes: 25 }] });

  // NPE 2024 per voting district: ward 1 has two VDs, ward 2 has one.
  const vd = (vdNo: number, ward: number, reg: number, cast: number, mk: number, anc: number) =>
    recordFetch(Source.NPEVDResults, `${NPE}:${vdNo}:${ward}`, 'u',
      { ElectoralEventID: NPE, VDNumber: vdNo, RegisteredVoters: reg, TotalVotesCast: cast,
        PartyBallotResults: [
          { ID: 9, Name: 'UMKHONTO WESIZWE', PartyAbbr: 'MK', ValidVotes: mk, PercOfVotes: 0 },
          { ID: 1, Name: 'AFRICAN NATIONAL CONGRESS', PartyAbbr: 'ANC', ValidVotes: anc, PercOfVotes: 0 }] });

  await vd(32940001, W1, 12000, 5400, 1800, 3000);
  await vd(32940002, W1,  8000, 3600, 1200, 2000);
  await vd(32940003, W2, 15000, 6000, 4000, 3000);

  await recordFetch(Source.VotingStation, '32940001', 'u',
    { Name: 'Hillbrow Primary', Location: { VDNumber: 32940001, WardID: W1, Latitude: -26.1876, Longitude: 28.0498 } });
  await recordFetch(Source.VotingStation, '32940003', 'u',
    { Name: 'Soweto Community Hall', Location: { VDNumber: 32940003, WardID: W2, Latitude: -26.2485, Longitude: 27.8540 } });
  // a station outside scope must be skipped, not crash the run
  await recordFetch(Source.VotingStation, '99999999', 'u',
    { Name: 'Out of province', Location: { VDNumber: 99999999, WardID: 11111111 } });

  console.log('promoteWards:', await promoteWards());
  console.log('promoteStations:', await promoteStations());
  await refreshExtract();
  console.log('extract refreshed + NOTIFY sent');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
