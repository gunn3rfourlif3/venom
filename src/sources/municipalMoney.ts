/* National Treasury Municipal Money.
 *
 * The only one of the named service-delivery sources that is a live API: no
 * credential, no registration, JSON over HTTPS. It is a Babbage/Cubes OLAP
 * server, so every query is a cut (filter) plus a drilldown (group by) against
 * a named cube, and the response comes back as "cells".
 *
 * WHAT IT GIVES US. Two things worth having. First, the authoritative
 * municipality list with Municipal Demarcation Board codes - the join key for
 * everything official. Second, income and expenditure broken out BY SERVICE:
 * electricity, water, waste water and waste management each have their own
 * revenue line. That is what makes it worth wiring to the sentiment screen -
 * complaints about refuse can sit beside what the municipality actually
 * billed for refuse.
 *
 * WHAT IT DOES NOT GIVE US. Any count of households served, any outage, any
 * fault report, and nothing below municipality level. The service-delivery
 * counts live in the Stats SA Non-Financial Census (P9115), which has no API
 * and is loaded by hand. Do not let a revenue line stand in for a household
 * count; they answer different questions.
 */

const BASE = 'https://municipaldata.treasury.gov.za/api';

/** Audited actuals. The alternatives are budgets and in-year reports, which
 *  are forecasts: for anything that will be argued about, use what the
 *  auditors signed. */
export const AUDITED_ACTUAL = 'AUDA';

export class MunicipalMoneyError extends Error {
  constructor(message: string, readonly status?: number, readonly url?: string) {
    super(message);
    this.name = 'MunicipalMoneyError';
  }
}

/** province_name -> the code this system uses. The cube's own province_code
 *  disagrees with itself (KZ/KZN, LP/LIM), so the name is the key to trust. */
export const PROVINCE_CODE: Record<string, string> = {
  'Eastern Cape': 'EC',
  'Free State': 'FS',
  'Gauteng': 'GT',
  'KwaZulu-Natal': 'KZN',
  'Limpopo': 'LIM',
  'Mpumalanga': 'MP',
  'Northern Cape': 'NC',
  'North West': 'NW',
  'Western Cape': 'WC',
};

export interface MunicipalityRow {
  demarcation_code: string;
  name: string;
  category: string | null;
  province_code: string | null;
  province_name: string | null;
}

/** An income/expenditure line for one municipality and year. */
export interface IncExpRow {
  demarcation_code: string;
  item_code: string;
  item_label: string;
  financial_year: number;
  amount: number;
}

/* The four service lines, and the grievance category each one answers to.
 * Treasury's labels are not the campaign's words - "Waste Management" is what
 * a voter calls refuse - so the mapping is written out rather than inferred. */
export const SERVICE_ITEMS: ReadonlyArray<{
  code: string; treasuryLabel: string; category: string;
}> = [
  { code: '0300', treasuryLabel: 'Service charges - Electricity',           category: 'Electricity' },
  { code: '0400', treasuryLabel: 'Service charges - Water',                 category: 'Water' },
  { code: '0500', treasuryLabel: 'Service charges - Waste Water Management', category: 'Sanitation' },
  { code: '0600', treasuryLabel: 'Service charges - Waste Management',      category: 'Refuse' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MunicipalMoneyClient {
  constructor(
    private readonly userAgent = 'venom/0.1 (ward analytics; contact via repo)',
    private readonly maxAttempts = 4,
  ) {}

  /** Cubes wants cut and drilldown as single strings with its own delimiters:
   *  `|` between dimensions, `;` between values, and quoted literals. Built
   *  here so no caller hand-rolls the escaping. */
  private static cut(parts: Record<string, string | number | Array<string | number>>): string {
    return Object.entries(parts)
      .map(([dim, v]) => {
        const values = Array.isArray(v) ? v : [v];
        const rendered = values
          .map((x) => (typeof x === 'number' ? String(x) : `"${String(x).replace(/"/g, '')}"`))
          .join(';');
        return `${dim}:${rendered}`;
      })
      .join('|');
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json', 'user-agent': this.userAgent },
          signal: AbortSignal.timeout(30_000),
        });

        // A public service we do not pay for: back off rather than retry hard.
        if (response.status === 429 || response.status >= 500) {
          lastError = new MunicipalMoneyError(
            `HTTP ${response.status} from Municipal Money`, response.status, url);
          await sleep(Math.min(16_000, 800 * 2 ** (attempt - 1)));
          continue;
        }
        if (!response.ok) {
          throw new MunicipalMoneyError(
            `HTTP ${response.status} from Municipal Money`, response.status, url);
        }
        return await response.json();
      } catch (error) {
        if (error instanceof MunicipalMoneyError && error.status && error.status < 500) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
        await sleep(Math.min(16_000, 800 * 2 ** (attempt - 1)));
      }
    }
    throw new MunicipalMoneyError(
      `Municipal Money unreachable after ${this.maxAttempts} attempts: ${String(lastError)}`,
      undefined, url);
  }

  /** Every municipality in a province, with its MDB code.
   *
   *  Note what comes back for Gauteng: thirteen rows, not nine. Two are
   *  district councils (DC42 Sedibeng, DC48 West Rand) which hold no wards of
   *  their own, and two are the dissolved Randfontein and Westonaria, which
   *  merged into Rand West City in 2016 and are kept so that historic figures
   *  still resolve. The caller decides which of those it wants; this method
   *  does not silently drop them. */
  /** Every municipality in the cube, in one request, with province codes
   *  normalised.
   *
   *  WHY NOT NINE CALLS FILTERED BY PROVINCE. Because the province_code in
   *  this cube is not consistent: the 54 current KwaZulu-Natal municipalities
   *  carry 'KZ' while the 11 abolished in the 2016 amalgamations carry 'KZN',
   *  and Limpopo is split the same way between 'LP' (27 current) and 'LIM'
   *  (6 defunct). Filtering on 'KZN' therefore returns only municipalities
   *  that no longer exist - which looks exactly like a province with eleven
   *  municipalities rather than like a bug.
   *
   *  province_name is consistent, so the code is derived from it here and the
   *  cube's own province_code is discarded. One unfiltered request also means
   *  no list of province codes to keep correct.
   */
  async allMunicipalities(): Promise<MunicipalityRow[]> {
    const body = await this.get('/cubes/municipalities/facts', {
      fields: [
        'municipality.demarcation_code', 'municipality.name', 'municipality.category',
        'municipality.province_code', 'municipality.province_name',
      ].join(','),
      page_size: '1000',
    });

    const rows = (body as { data?: Array<Record<string, unknown>> }).data ?? [];
    return rows.map((r) => {
      const name = r['municipality.province_name'] == null
        ? null : String(r['municipality.province_name']);
      return {
        demarcation_code: String(r['municipality.demarcation_code']),
        name: String(r['municipality.name']),
        category: r['municipality.category'] == null ? null : String(r['municipality.category']),
        province_code: PROVINCE_CODE[name ?? ''] ?? null,
        province_name: name,
      };
    });
  }

  async municipalities(provinceCode = 'GT'): Promise<MunicipalityRow[]> {
    const body = await this.get('/cubes/municipalities/facts', {
      cut: MunicipalMoneyClient.cut({ 'municipality.province_code': provinceCode }),
      fields: [
        'municipality.demarcation_code', 'municipality.name', 'municipality.category',
        'municipality.province_code', 'municipality.province_name',
      ].join(','),
      page_size: '200',
    });

    const rows = (body as { data?: Array<Record<string, unknown>> }).data ?? [];
    return rows.map((r) => ({
      demarcation_code: String(r['municipality.demarcation_code']),
      name: String(r['municipality.name']),
      category: r['municipality.category'] == null ? null : String(r['municipality.category']),
      province_code: r['municipality.province_code'] == null ? null : String(r['municipality.province_code']),
      province_name: r['municipality.province_name'] == null ? null : String(r['municipality.province_name']),
    }));
  }

  /** Service-charge revenue by item for one municipality and financial year.
   *
   *  Returns every item the cube holds, not just the four service lines, so
   *  that a caller can see the whole statement; filtering to SERVICE_ITEMS is
   *  the promoter's job and is visible there. */
  async incomeAndExpenditure(
    demarcationCode: string,
    financialYear: number,
    amountType: string = AUDITED_ACTUAL,
  ): Promise<IncExpRow[]> {
    const body = await this.get('/cubes/incexp_v2/aggregate', {
      aggregates: 'amount.sum',
      cut: MunicipalMoneyClient.cut({
        'demarcation.code': demarcationCode,
        'financial_year_end.year': financialYear,
        'amount_type.code': amountType,
      }),
      drilldown: 'item.code|item.label',
      page_size: '200',
    });

    const cells = (body as { cells?: Array<Record<string, unknown>> }).cells ?? [];
    return cells
      .filter((c) => c['amount.sum'] != null)
      .map((c) => ({
        demarcation_code: demarcationCode,
        item_code: String(c['item.code']),
        item_label: String(c['item.label'] ?? ''),
        financial_year: financialYear,
        amount: Number(c['amount.sum']),
      }));
  }

  /** Unauthorised, irregular, and fruitless and wasteful expenditure.
   *
   *  Three lines straight out of the audited annual financial statements.
   *  For Johannesburg in 2024 they run to billions, and unlike a sentiment
   *  score these are not an estimate of anything - they are what the
   *  Auditor-General signed off. No amount_type dimension on this cube;
   *  it is audited figures only, which is the whole point of it. */
  async uifw(demarcationCode: string, financialYear: number): Promise<IncExpRow[]> {
    const body = await this.get('/cubes/uifwexp/aggregate', {
      aggregates: 'amount.sum',
      cut: MunicipalMoneyClient.cut({
        'demarcation.code': demarcationCode,
        'financial_year_end.year': financialYear,
      }),
      drilldown: 'item.code|item.label',
      page_size: '50',
    });
    const cells = (body as { cells?: Array<Record<string, unknown>> }).cells ?? [];
    return cells
      .filter((c) => c['amount.sum'] != null)
      .map((c) => ({
        demarcation_code: demarcationCode,
        item_code: String(c['item.code']),
        item_label: String(c['item.label'] ?? ''),
        financial_year: financialYear,
        amount: Number(c['amount.sum']),
      }));
  }

  /** What was spent keeping existing infrastructure working.
   *
   *  The figure behind every pothole and burst pipe argument, and the one
   *  that pairs with a refuse or water complaint more directly than revenue
   *  does: revenue says what was billed, this says what was repaired. */
  async repairsAndMaintenance(
    demarcationCode: string, financialYear: number, amountType: string = AUDITED_ACTUAL,
  ): Promise<number | null> {
    const body = await this.get('/cubes/repmaint_v2/aggregate', {
      aggregates: 'amount.sum',
      cut: MunicipalMoneyClient.cut({
        'demarcation.code': demarcationCode,
        'financial_year_end.year': financialYear,
        'amount_type.code': amountType,
      }),
      page_size: '1',
    });
    const summary = (body as { summary?: Record<string, unknown> }).summary;
    const total = summary?.['amount.sum'];
    return total == null ? null : Number(total);
  }

  /** The Auditor-General's opinion, and a link to the report itself. */
  async auditOpinion(
    demarcationCode: string, financialYear: number,
  ): Promise<{ code: string; label: string; reportUrl: string | null } | null> {
    const body = await this.get('/cubes/audit_opinions/facts', {
      cut: MunicipalMoneyClient.cut({
        'demarcation.code': demarcationCode,
        'financial_year_end.year': financialYear,
      }),
      fields: 'opinion.code,opinion.label,opinion.report_url',
      page_size: '1',
    });
    const row = ((body as { data?: Array<Record<string, unknown>> }).data ?? [])[0];
    if (!row || row['opinion.code'] == null) return null;
    return {
      code: String(row['opinion.code']),
      label: String(row['opinion.label'] ?? ''),
      reportUrl: row['opinion.report_url'] == null ? null : String(row['opinion.report_url']),
    };
  }

  /** The URL a figure came from, recorded as provenance beside it. */
  static factsUrl(cube: string, demarcationCode: string, year: number): string {
    return `${BASE}/cubes/${cube}/aggregate?cut=demarcation.code:"${demarcationCode}"|financial_year_end.year:${year}`;
  }
}

/* Audit opinions are words, and service_fact stores numbers. Rather than add
 * a text column for one source, the opinion is stored as its severity rank
 * with the publisher's own wording kept verbatim beside it - so the dashboard
 * can sort and colour by severity while still showing exactly what the
 * Auditor-General said. An unrecognised code is skipped rather than guessed
 * at: inventing a rank for an opinion we do not know is worse than a gap. */
export const AUDIT_SEVERITY: Record<string, number> = {
  unqualified: 0,            // clean
  financially_unqualified: 1, // unqualified with findings
  qualified: 2,
  adverse: 3,
  disclaimer: 4,
  outstanding: 5,            // never submitted, which is its own answer
};
