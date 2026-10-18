import { pool } from '../db.js';

/* The control panel: every parameter the model runs on.
 *
 * These are not preferences. Changing leakage_basis moves the campaign's
 * headline number by hundreds of thousands of votes, and changing the three
 * priority weights reorders which wards get people on the day. So writes are
 * administrator-only, every field is validated here as well as in the schema,
 * and the row records who changed it and when.
 *
 * The field list is declared rather than inferred from the table, because a
 * column added to control_panel should not become editable in the dashboard
 * the moment it exists - someone has to decide it is safe to expose and what
 * it means in plain words.
 */

export type FieldKind = 'money' | 'ratio' | 'share' | 'weight' | 'days' | 'count' | 'choice';

export interface Field {
  key: string;
  label: string;
  /** What it does, in the words of someone running a campaign. */
  help: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  choices?: Array<{ value: string; label: string; help: string }>;
  group: 'Money' | 'The model' | 'Priority' | 'Pressure' | 'Sentiment';
}

export const FIELDS: Field[] = [
  { key: 'transport_rate_per_body', label: 'Transport per person', group: 'Money',
    help: 'What it costs to move one person to a ward for the day.',
    kind: 'money', min: 0, max: 100000, step: 10 },
  { key: 'catering_rate_per_head', label: 'Catering per person', group: 'Money',
    help: 'Food for one person for the day.',
    kind: 'money', min: 0, max: 100000, step: 10 },

  { key: 'leakage_factor', label: 'Leakage', group: 'The model',
    help: 'The share of a ward\'s vote assumed lost to rivals and non-turnout. '
        + 'Charged against the base below.',
    kind: 'ratio', min: 0, max: 1, step: 0.01 },
  { key: 'leakage_basis', label: 'Leakage charged against', group: 'The model',
    help: 'Which population leakage is taken from. This moves the headline '
        + 'number more than anything else on this screen.',
    kind: 'choice', choices: [
      { value: 'OWN_VOTE', label: 'Our own voters',
        help: 'Leakage is a share of our vote. The narrowest reading.' },
      { value: 'POOL_SHARE', label: 'Our share of the pool',
        help: 'Scaled by how much of the contestable pool is ours.' },
      { value: 'ALL', label: 'All 2024 voters',
        help: 'A share of everyone who voted. The widest, and the harshest.' },
    ]},
  { key: 'reliability_default', label: 'Assumed reliability', group: 'The model',
    help: 'Used for a ward with no delivery history yet. 0.5 means half of '
        + 'what was claimed is believed.',
    kind: 'ratio', min: 0, max: 1, step: 0.05 },
  { key: 'swing_threshold_share', label: 'Swing threshold', group: 'The model',
    help: 'How close a ward must be, as a share of the pool, to count as '
        + 'contestable. Not yet calibrated against real IEC results.',
    kind: 'share', min: 0, max: 1, step: 0.005 },
  { key: 'peak_basis', label: 'Peak turnout measured on', group: 'The model',
    help: 'Which past elections set the ceiling a ward could reach.',
    kind: 'choice', choices: [
      { value: 'LGE', label: 'Local elections only',
        help: 'Compares like with like. Local turnout is always lower.' },
      { value: 'ALL', label: 'All elections',
        help: 'Includes national turnout, so the ceiling is higher and the gap wider.' },
    ]},

  { key: 'weight_swing', label: 'Contestability', group: 'Priority',
    help: 'How much a ward being winnable counts toward its rank.',
    kind: 'weight', min: 0, max: 1, step: 0.05 },
  { key: 'weight_headroom', label: 'Headroom', group: 'Priority',
    help: 'How much unrealised turnout counts.',
    kind: 'weight', min: 0, max: 1, step: 0.05 },
  { key: 'weight_reliability', label: 'Reliability', group: 'Priority',
    help: 'How much a ward team\'s delivery record counts.',
    kind: 'weight', min: 0, max: 1, step: 0.05 },

  { key: 'pressure_window_days', label: 'Pressure window', group: 'Pressure',
    help: 'How far back grievance reports are counted.',
    kind: 'days', min: 1, max: 365, step: 1 },
  { key: 'pressure_elevated_at', label: 'Elevated at', group: 'Pressure',
    help: 'Open issues in a ward before it reads as elevated.',
    kind: 'count', min: 0, max: 1000, step: 1 },
  { key: 'pressure_high_at', label: 'High at', group: 'Pressure',
    help: 'Open issues before it reads as high. Must exceed elevated.',
    kind: 'count', min: 0, max: 1000, step: 1 },

  { key: 'sentiment_window_days', label: 'Sentiment window', group: 'Sentiment',
    help: 'How far back the sentiment screen looks.',
    kind: 'days', min: 7, max: 365, step: 1 },
  { key: 'sentiment_strong_at', label: 'Strong at', group: 'Sentiment',
    help: 'Absolute score at which a reading counts as strongly held.',
    kind: 'ratio', min: 0.001, max: 1, step: 0.05 },
  { key: 'sentiment_mixed_at', label: 'Mixed below', group: 'Sentiment',
    help: 'Below this the reading is mixed. Must be under strong.',
    kind: 'ratio', min: 0.001, max: 1, step: 0.05 },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export interface ValidationProblem { key: string; message: string; }

/** Validated here as well as in the database. The CHECK constraints are the
 *  real guarantee; this exists so the screen can say which field is wrong
 *  and why, rather than surfacing a constraint name at the person. */
export function validate(patch: Record<string, unknown>): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  for (const [key, raw] of Object.entries(patch)) {
    const field = BY_KEY.get(key);
    if (!field) { problems.push({ key, message: 'not a control panel field' }); continue; }

    if (field.kind === 'choice') {
      if (!field.choices!.some((c) => c.value === raw)) {
        problems.push({ key, message: `must be one of ${field.choices!.map((c) => c.value).join(', ')}` });
      }
      continue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) { problems.push({ key, message: 'must be a number' }); continue; }
    if (field.min !== undefined && value < field.min) {
      problems.push({ key, message: `must be at least ${field.min}` });
    }
    if (field.max !== undefined && value > field.max) {
      problems.push({ key, message: `must be at most ${field.max}` });
    }
    if ((field.kind === 'days' || field.kind === 'count') && !Number.isInteger(value)) {
      problems.push({ key, message: 'must be a whole number' });
    }
  }
  return problems;
}

/** Cross-field rules the schema also enforces, checked against the merged
 *  row rather than the patch, so changing one half of a pair is allowed. */
export function validateTogether(merged: Record<string, unknown>): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const n = (k: string) => Number(merged[k]);

  const weights = n('weight_swing') + n('weight_headroom') + n('weight_reliability');
  // The schema demands exactly 1. Rounding is allowed here because the form
  // sends values the person typed, not values a computer produced.
  if (Math.abs(weights - 1) > 0.0005) {
    problems.push({
      key: 'weight_swing',
      message: `the three priority weights must add to 1 (they add to ${weights.toFixed(3)})`,
    });
  }
  if (n('pressure_high_at') <= n('pressure_elevated_at')) {
    problems.push({ key: 'pressure_high_at', message: 'high must be above elevated' });
  }
  if (n('sentiment_strong_at') <= n('sentiment_mixed_at')) {
    problems.push({ key: 'sentiment_strong_at', message: 'strong must be above mixed' });
  }
  return problems;
}

export async function readPanel(): Promise<Record<string, unknown>> {
  const result = await pool.query('SELECT * FROM control_panel WHERE id');
  return result.rows[0] ?? {};
}

export async function writePanel(
  patch: Record<string, unknown>, updatedBy: string,
): Promise<{ row?: Record<string, unknown>; problems: ValidationProblem[] }> {
  const problems = validate(patch);
  if (problems.length > 0) return { problems };

  const current = await readPanel();
  const merged = { ...current, ...patch };
  const together = validateTogether(merged);
  if (together.length > 0) return { problems: together };

  const keys = Object.keys(patch);
  if (keys.length === 0) return { row: current, problems: [] };

  const assignments = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map((k) => patch[k]);
  const result = await pool.query(
    `UPDATE control_panel
        SET ${assignments}, updated_at = now(), updated_by = $${keys.length + 1}
      WHERE id RETURNING *`,
    [...values, updatedBy]);

  return { row: result.rows[0], problems: [] };
}
