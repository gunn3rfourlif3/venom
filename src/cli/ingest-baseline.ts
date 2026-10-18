/**
 * Fetch the electoral baseline into staging. Writes nothing to canonical
 * tables — run `npm run promote` afterwards for that.
 *
 * Safe to re-run: an unchanged payload is recorded and marked promoted, so
 * promotion ignores it.
 *
 *   npm run build && npm run ingest:baseline
 */
import { config } from '../config.js';
import { pool } from '../db.js';
import { IECClient } from '../iec/client.js';
import { recordFetch } from '../ingest/fetch.js';
import { Source } from '../ingest/sources.js';
import { classify, yearOf } from '../ingest/promote.js';
import type {
  ElectoralEvent, ElectoralEventType, DelimitationProvince,
} from '../iec/types.js';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

async function main(): Promise<void> {
  const iec = new IECClient();

  // 1. Discover events. Never hardcode an electoral event id: they change
  //    every cycle, and the type descriptions do not.
  const types = await iec.get<ElectoralEventType[]>('ElectoralEvent');
  const wanted: Array<{ id: number; kind: string; year: number | null; description: string }> = [];

  for (const type of types) {
    const events = await iec.electoralEvents(type.ID);
    await recordFetch(
      Source.ElectoralEvents,
      String(type.ID),
      iec.endpointUrl('ElectoralEvent', { ElectoralEventTypeID: type.ID }),
      { typeId: type.ID, typeDescription: type.Description, events },
    );
    const kind = classify(type.Description);
    if (kind === 'OTHER') continue;
    for (const event of events as ElectoralEvent[]) {
      const year = yearOf(event.Description);
      if (kind === 'LGE' || (kind === 'NPE' && year === 2024)) {
        wanted.push({ id: event.ID, kind, year, description: event.Description });
      }
    }
  }
  log(`electoral events in scope: ${wanted.map((e) => `${e.description}(${e.id})`).join(', ')}`);
  if (wanted.length === 0) throw new Error('No electoral events matched — check API access');

  // Delimitation comes from the most recent event: current boundaries.
  const current = wanted.reduce((a, b) => ((b.year ?? 0) > (a.year ?? 0) ? b : a));
  log(`delimitation from: ${current.description} (${current.id})`);

  // 2. Province
  const provinces = await iec.provinces(current.id);
  await recordFetch(
    Source.Provinces, null,
    iec.endpointUrl('Delimitation', { ElectoralEventID: current.id }),
    provinces,
  );
  const province = (provinces as DelimitationProvince[]).find(
    (p) => p.Province?.toLowerCase() === config.scope.province.toLowerCase(),
  );
  if (!province) {
    throw new Error(
      `Province "${config.scope.province}" not found. Available: ` +
      provinces.map((p) => p.Province).join(', '),
    );
  }
  log(`province: ${province.Province} (${province.ProvinceID})`);

  // 3. Municipalities, wards, voting districts
  const municipalities = await iec.municipalities(current.id, province.ProvinceID);
  await recordFetch(
    Source.Municipalities, String(province.ProvinceID),
    iec.endpointUrl('Delimitation', {
      ElectoralEventID: current.id, ProvinceID: province.ProvinceID,
    }),
    municipalities,
  );
  log(`municipalities: ${municipalities.length}`);

  const wardIndex: Array<{ wardId: number; municipalityId: number }> = [];
  for (const municipality of municipalities) {
    const wards = await iec.wards(current.id, province.ProvinceID, municipality.MunicipalityID);
    await recordFetch(
      Source.Wards, String(municipality.MunicipalityID),
      iec.endpointUrl('Delimitation', {
        ElectoralEventID: current.id,
        ProvinceID: province.ProvinceID,
        MunicipalityID: municipality.MunicipalityID,
      }),
      wards,
    );
    for (const ward of wards) {
      wardIndex.push({ wardId: ward.WardID, municipalityId: municipality.MunicipalityID });
    }
  }
  log(`wards: ${wardIndex.length}`);

  const vdIndex: Array<{ vd: number; wardId: number; municipalityId: number }> = [];
  for (const ward of wardIndex) {
    const vds = await iec.votingDistricts(
      current.id, province.ProvinceID, ward.municipalityId, ward.wardId,
    );
    await recordFetch(
      Source.VotingDistricts, String(ward.wardId),
      iec.endpointUrl('Delimitation', {
        ElectoralEventID: current.id,
        ProvinceID: province.ProvinceID,
        MunicipalityID: ward.municipalityId,
        WardID: ward.wardId,
      }),
      vds,
    );
    for (const vd of vds) {
      vdIndex.push({ vd: vd.VDNumber, wardId: ward.wardId, municipalityId: ward.municipalityId });
    }
  }
  log(`voting districts: ${vdIndex.length}`);

  // 4. LGE results per ward, per past local government event
  for (const event of wanted.filter((e) => e.kind === 'LGE')) {
    let ok = 0;
    for (const ward of wardIndex) {
      try {
        const result = await iec.lgeResultsByWard(
          event.id, province.ProvinceID, ward.municipalityId, ward.wardId,
        );
        await recordFetch(
          Source.LGEWardResults, `${event.id}:${ward.wardId}`,
          iec.endpointUrl('LGEBallotResults', {
            ElectoralEventID: event.id,
            ProvinceID: province.ProvinceID,
            MunicipalityID: ward.municipalityId,
            WardID: ward.wardId,
          }),
          result,
        );
        ok += 1;
      } catch (error) {
        log(`  LGE ${event.id} ward ${ward.wardId} failed: ${(error as Error).message}`);
      }
    }
    log(`LGE ${event.description}: ${ok}/${wardIndex.length} wards`);
  }

  // 5. NPE results per voting district. There is no ward-level national
  //    endpoint, so ward figures are summed from these at promotion.
  for (const event of wanted.filter((e) => e.kind === 'NPE')) {
    let ok = 0;
    for (const entry of vdIndex) {
      try {
        const result = await iec.npeResultsByVotingDistrict(
          event.id, province.ProvinceID, entry.municipalityId, entry.vd,
        );
        await recordFetch(
          Source.NPEVDResults, `${event.id}:${entry.vd}:${entry.wardId}`,
          iec.endpointUrl('NPEBallotResults', {
            ElectoralEventID: event.id,
            ProvinceID: province.ProvinceID,
            MunicipalityID: entry.municipalityId,
            VDNumber: entry.vd,
          }),
          result,
        );
        ok += 1;
      } catch (error) {
        log(`  NPE ${event.id} VD ${entry.vd} failed: ${(error as Error).message}`);
      }
    }
    log(`NPE ${event.description}: ${ok}/${vdIndex.length} voting districts`);
  }

  // 6. Voting stations
  let stations = 0;
  for (const entry of vdIndex) {
    try {
      const details = await iec.votingStationByVD(entry.vd);
      await recordFetch(
        Source.VotingStation, String(entry.vd),
        iec.endpointUrl('VotingStationDetails', { VDNumber: entry.vd }),
        details,
      );
      stations += 1;
    } catch (error) {
      log(`  station VD ${entry.vd} failed: ${(error as Error).message}`);
    }
  }
  log(`voting stations: ${stations}/${vdIndex.length}`);
  log('staging complete — run `npm run promote`');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
