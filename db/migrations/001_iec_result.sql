-- iec_result — the post-election booth count.
--
-- Introduced so that v_ward_eo.eo_act_votes has somewhere to come from.
-- A view cannot be written to, so the actual count cannot live in
-- v_ward_eo itself. Loaded from the IEC declaration after the election;
-- empty until then, which leaves eo_act_votes NULL and calibration_error
-- NULL, as expected.
--
-- The remaining base tables (ward, station, asset_holding, liquidatable,
-- deployment, float_ledger, call_log, control_panel) still have no DDL.

CREATE TABLE iec_result (
  ward_id       text PRIMARY KEY,
  eo_act_votes  integer,
  declared_at   date,
  source        text
);
