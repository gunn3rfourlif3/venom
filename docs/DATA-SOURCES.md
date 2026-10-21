# Data sources

What exists, what does not, what is connected, and what each source can
honestly be said to measure. Every claim here was checked against the
publisher in October 2026 rather than recalled — where a figure matters, the
source is linked at the bottom.

---

## 1. Connected and working

| Source | Access | Geography | Measures |
|---|---|---|---|
| `local_press` — 22 Gauteng community papers | Open RSS | Municipality | Local press attention to a service in an area |
| `news` — category-targeted queries | Open | Municipality | National/regional coverage of a service issue |
| `instagram` — hashtag aggregates | Keyed, aggregate-only | Municipality | Volume of tagged posts. Never per-account |
| `municipalmoney` — municipalmoney.gov.za | Open | Municipality | Audited finance: income/expenditure, UIFW, repairs, audit opinion |
| `SYNTHETIC` | n/a | Ward | Nothing. A clearly-stamped baseline so screens have shape before real data lands |

Three constraints hold across all of them and do not relax with scale:

- **Counts to disk, text in memory.** Item text is scored and discarded; only
  aggregates persist
- **No identifiable individuals.** No names, handles, contact details, identity
  numbers or attributed quotes. Enforced by CHECK constraints in migration 013
- **Provenance on the face of every figure.** Each sentiment view groups by
  source, so synthetic and real are never averaged into one number

---

## 2. Election results — IEC

**The results portal publishes municipal elections for 2000, 2006, 2011, 2016,
2021 and 2026**, at five levels: Province, Municipality, Ward, Ballot and
**Voting District**. Formats are **PDF and Excel**. National and provincial
election reports go back to **1999**.

Practical consequences:

- **There is no API.** This is a download-and-parse pipeline, not an
  integration. Build it as an idempotent loader over archived files, keeping
  the original download so a parse bug is re-runnable without re-fetching
- **2000 is the floor for municipal data.** See §3
- **Excel beats PDF** wherever both exist. Parse the workbooks; use the PDFs
  only to verify totals

### The delimitation vintage requirement

Ward boundaries are redrawn before every municipal election. A result must be
stored against the **delimitation vintage it was published under**, and
cross-vintage comparison requires an explicit boundary crosswalk. Without it,
"Ward 42 swung 9%" may be entirely an artefact of Ward 42 being a different
place. See `GOTCHAS.md` G2.

---

## 3. Why 1994 is not available

The Todo asks for data back to 1994. At ward or voting-district level it does
not exist and cannot be reconstructed:

- **No voters' roll existed.** The parties judged there was no time to compile
  one and the electoral act made no provision for it. Eligibility was checked
  against an identity document at the polling station, with indelible UV ink
  against double voting
- **Counting was centralised.** Planned counting stations were cut from 670 to
  **70**, and votes were counted away from where they were cast. The procedure
  for tracing each ballot box back to its polling station broke down, and the
  decision was taken to count regardless
- **Municipal wards did not exist** in the current sense. The present municipal
  system and its demarcation date from 2000

So: **municipal from 2000, national from 1999.** 1994–96 is narrative context,
not data. Five municipal cycles is more than enough for the trend work the
system needs.

---

## 4. Voting districts

For 2026 the MDB handed over **4,488 wards** and the same figure is used for
voting districts, against **23,699 voting stations** — so a ward typically
contains several stations, and VD and ward are effectively the same unit for
this election. The drill-down the Todo asks for is therefore
**ward → station**, which is the granularity the logistics layer already uses.

- **Results at VD level:** available from the IEC portal (VD is one of the five
  report levels)
- **Station register:** the IEC publishes the voting station list; confirming
  the exact published format is day one of the 14-day plan
- **Boundaries (geospatial):** MDB publishes ward boundaries; the IEC publishes
  VD boundaries. Confirming current download formats is `OPEN-QUESTIONS.md` Q4

---

## 5. Taxi routes — no national source

The Todo asks for a "Taxi Route API" overlay. There is not one, and the obvious
candidate is gone:

- **WhereIsMyTransport shut down in 2023**, having failed to raise funding. Do
  not build against it
- **City of Cape Town** publishes a Taxi Routes dataset on its open data
  portal — real, but Cape Town only
- **Gauteng has no equivalent open dataset** that I could confirm. Candidates
  to approach: GCRO, the Gauteng Department of Roads and Transport, and the
  Transport Africa / DigitalTransport4Africa GTFS repositories
- **OpenStreetMap** carries some minibus routes from community mapping efforts,
  with uneven coverage and unknown currency

The deeper problem is that minibus taxi routes are **informal and change**.
Even a good dataset is a snapshot of a system that reorganises around demand,
roadworks and rank politics. A routing overlay built on stale route data will
be confidently wrong about how a driver actually gets somewhere.

**Recommendation:** drop the taxi overlay from the routing feature and use a
commercial maps API for actual driver routing (which models real road
conditions). Keep taxi routes as a separate, clearly-dated *context* layer
where data exists — useful for understanding how voters reach a station, which
is the genuinely valuable question — rather than as an input to live routing.

---

## 6. TikTok — no lawful route

The Todo asks for a TikTok hashtag scraper with comment search. Both available
routes are closed, and this is not a scheduling decision.

**The official route: TikTok Research API.** Eligibility is restricted to:
- Academic institutions in the US, EEA, UK, Canada or Switzerland
- Not-for-profit and independent research bodies in the EU (beta elsewhere)
- Academic or non-profit organisations in Brazil, youth-safety research only

Applicants must be **independent of commercial interests**, research on a
non-commercial basis, submit a defined research proposal, and provide
**evidence of ethical review**.

A South African political party's campaign tool fails on **every** criterion:
wrong region, wrong organisation type, not independent of interest, and no
ethics board. There is no application that succeeds here.

**The scraping route — Apify, Scrapfly, Bright Data, comment-scraper actors —
stays declined,** as it was when first raised. Three reasons, unchanged:

1. It circumvents an access-control decision the platform has made about this
   specific use case. The eligibility rules above *are* the decision
2. **Comment scraping harvests identifiable private individuals into a
   political targeting system.** That is the precise thing Xnith's "issues, not
   people" rule exists to prevent, and it would be the one component
   contradicting the constraint the rest of the system is built around
3. Under POPIA, **collection is itself processing.** There is no safe
   intermediate state where the data has been gathered but not yet used, and no
   lawful basis for scraping identifiable commentary on political topics
   without consent. Special personal information — which political opinion
   is — carries a higher bar still

The reputational exposure is also asymmetric and worth saying plainly: a party
caught scraping citizens' social media comments into a targeting database is a
front-page story, in a way that a party simply not having that data is not.

**What to do instead**, for the question the scraper was meant to answer
(*what are people locally angry about?*):

- **Local press is the better instrument anyway.** The 22 connected Gauteng
  titles cover single suburbs — Pimville, Katlehong, Meyerton, Ga-Rankuwa — at
  a finer geography than any hashtag gives. A hashtag is province-wide at best
  and carries no reliable location. Expanding to ~100+ titles nationally uses
  the adapter that already works
- **Aggregate-only social**, as the Instagram adapter already does: counts per
  hashtag per area, no account-level data, no comment text
- **Ward-level grievance intake from our own people** — the marshals and
  canvassers already reporting. First-party, consented, and more accurate about
  our own wards than any platform
- **Service-delivery facts** from municipalmoney.gov.za and Stats SA: slower
  than sentiment, and causal rather than correlated

---

## 7. Worth adding, with reasons

| Source | What it adds | Effort |
|---|---|---|
| **Stats SA Census 2022 / Community Survey** | Ward-level demographics, employment, dwelling type, service access. Turns sentiment from a count into a rate, and is the main missing input to any turnout model | Medium — bulk download, ward-level crosswalk needed |
| **Eskom load-shedding schedules** | Electricity grievance is one of the largest categories; the schedule tells you whether a spike is a real local fault or a national stage change. Removes a whole class of false signal | Low |
| **Municipal outage feeds** (Joburg Water, City Power, Rand Water) | Ground truth for the water and electricity categories. Confirms or refutes press sentiment on the same day | Low–medium, per municipality |
| **MDB boundary archive, all vintages** | The crosswalk that makes cross-year comparison valid at all. Required before any multi-cycle trend claim | Medium, and a prerequisite for L6 forecasting |
| **IEC voter registration statistics by ward** | Registration *change* per ward is the strongest single leading indicator of turnout change, and it is published between elections | Low |
| **Municipal IDP and budget documents** | What the municipality has *promised* per ward. The gap between promise and delivery is the most actionable grievance there is | Medium — PDF parsing |
| **Court rolls / Auditor-General reports** | Already partly covered via audit opinion. AG reports carry detail the summary metrics lose | Medium |

**The highest-value single addition is Stats SA ward demographics.** Almost
every analytical weakness in the current system — sentiment as counts rather
than rates, no turnout model, no way to weight a ward's signal by its size —
traces back to not having it.

---

## Sources

- [IEC municipal election results downloads](https://results.elections.org.za/home/downloads/me-results)
- [IEC national and provincial election reports](https://www.elections.org.za/pw/downloads/Documents-National-And-Provincial-Election-Reports)
- [MDB Bulletin, December 2025 — final 2026 wards handed to the IEC](https://www.demarcation.org.za/wp-content/uploads/2026/01/MDB-Bulletin-December-1.pdf)
- [MDB briefing to Parliament on ward delimitation — the norm and the 15% variance](https://pmg.org.za/committee-meeting/29301/)
- [MDB ward delimitation booklet](https://www.demarcation.org.za/wp-content/uploads/2021/06/MDB-WARD-DELIMITATION-BOOKLET.pdf)
- [IEC secures 23,696 voting stations for 4 November](https://iol.co.za/news/politics/2026-09-18-iec-says-23696-voting-stations-secured-for-november-local-elections/)
- [2026 South African municipal elections](https://en.wikipedia.org/wiki/2026_South_African_municipal_elections)
- [Organizing the first post-apartheid election, 1994 — Princeton](https://successfulsocieties.princeton.edu/sites/g/files/toruqf5601/files/Organizing%20Post%20Apartheid_South%20Africa_ToU_1.pdf)
- [TikTok Research API — access and eligibility](https://developers.tiktok.com/products/research-api/)
- [WhereIsMyTransport shuts down](https://techcabal.com/2023/10/26/whereismytransport-shutting-down/)
- [City of Cape Town taxi routes dataset](https://odp-cctegis.opendata.arcgis.com/datasets/taxi-routes)
- [Open mapping minibus routes in South Africa](https://blog.okfn.org/2020/05/22/open-mapping-minibus-routes-in-south-africa-open-data-day-2020-report/)
