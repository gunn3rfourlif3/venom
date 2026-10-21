# Provider app — specification

The bespoke app for service providers: drivers, marshals, volunteers.
Registration, assignment, tracking while on an assignment, and the record that
payment is calculated from.

**Distribution: signed `.apk` from the party website.** Decided. The
consequences of that choice are engineering requirements, not objections, and
they are set out below — the first one is load-bearing and easy to miss.

Timing: post-election (Phase 5 in `BUILD-PLAN.md`). Nothing here is buildable
before 4 November, and the election itself produces the requirements.

---

## 1. Sideloading is viable, and it avoids a worse problem

I argued against APK distribution earlier. Having checked the current position
properly, the objection was weaker than I made it and there is a real argument
in favour that I did not raise.

**Where Android actually stands.** Google began enforcing developer
verification for sideloaded apps on **30 September 2026** — but only in
**Brazil, Indonesia, Singapore and Thailand**, and only for apps distributed
through seven participating app stores. Direct APK downloads are not subject to
the checks anywhere yet. Global expansion is planned for **2027** with no
announced date.

So for South Africa, for 4 November 2026: **APK installs work normally.**

**And the argument for it.** Google Play restricts background location to apps
where it is core functionality, reviews each case, and states that following
their guidance does not guarantee approval. A political party's app that tracks
volunteer drivers' location is exactly the submission that attracts scrutiny,
on an unpredictable timeline. Sideloading removes that review from the critical
path entirely. That is a bigger risk avoided than the one I was worried about.

**What to do now, because 2027 is coming.** Register as a verified developer
through the Android Developer Console: $25 and identity verification. The free
tier is capped at 20 authorised devices, which is useless at this scale, so it
has to be the paid one. Do it now rather than in the month enforcement reaches
South Africa — this app will outlive this election, through by-elections and
2031.

**The residual risk, and how to manage it.** The real exposure is not users
enabling an install permission; it is someone cloning the website and serving a
malicious APK to the party's own supporters. Two cheap mitigations:

- **Publish the official APK's SHA-256 on the download page**, and in the
  install guide tell people how to check it. Most will not. It still matters,
  because it gives anyone who suspects a fake a way to prove it
- **Pin the signing certificate server-side.** The app sends its own signing
  certificate hash on sign-in and the API refuses any client whose hash is not
  the expected one. A recompiled or repackaged clone can then collect
  credentials but cannot talk to Xnith, which removes most of the value in
  making one

---

## 2. The thing sideloading breaks: updates

**There is no auto-update.** Play Store apps update themselves. A sideloaded
APK does not, ever, unless the app does it itself.

Spelled out, because the failure mode is severe: ship a bug on 2 November and
every installed device keeps running it until each user manually visits the
website and reinstalls. At 100,000 installs that is not a fix, it is a press
release.

**So an in-app updater is a day-one requirement, not a later nicety:**

- On launch and every few hours, `GET /api/app/version` → latest version,
  minimum supported version, APK URL, SHA-256
- If below minimum supported: **block use** and offer the download. A client
  too old to be trusted must not file reports
- If merely behind: prompt, dismissible
- Download, verify the hash before prompting the install, then hand to the
  package installer. Needs `REQUEST_INSTALL_PACKAGES`
- Server keeps the last two versions downloadable, so a bad release can be
  rolled back by pointing the endpoint at the previous one

The `minimum supported version` field is the important one. It is the only
remote kill-switch available for a sideloaded fleet, and on election day it is
the difference between fixing a problem and watching it.

**Keystore custody.** Sign every release with the same key. **If the keystore
is lost, the app can never be updated again** — users must uninstall and
reinstall a differently-signed build, and on a volunteer workforce that is
equivalent to losing them. Keep it in two places, one offline, with the
password stored separately. This is worth more care than it sounds: it is the
single unrecoverable mistake available in this plan.

---

## 3. Background location — the permission reality

The Todo wants drivers tracked. Android makes this deliberately difficult, and
the friction lands on the volunteer, so the flow has to be designed rather than
assumed.

**What the platform requires:**

| | |
|---|---|
| Manifest | `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` |
| Order | Foreground location first, as its own request. Background location **cannot** be requested in the same dialog |
| Android 11+ | Background location cannot be granted from a dialog at all. The user must open the app's Settings page and choose **"Allow all the time"** |
| Android 14+ | `FOREGROUND_SERVICE_LOCATION` permission, and the service must declare `foregroundServiceType="location"` |
| Android 12+ | A foreground service cannot be started from the background — start it while the app is visible |
| Always | A **persistent notification** for the whole time tracking runs |

**Consequences for adoption, which is the real constraint:**

- Getting a driver to "Allow all the time" is a guided trip into system
  settings. Build that as a screen with device-specific instructions, not a
  toast saying "please enable background location"
- **Measure drop-off at every step** — installed, registered, foreground
  granted, background granted, battery exemption granted. Expect meaningful
  loss at each. The number that matters operationally is how many drivers are
  actually trackable, not how many installed
- Tell drivers about the persistent notification **before** they see it.
  Unexplained, it reads as spyware and they force-stop the app
- Battery optimisation will kill the service on many manufacturer skins
  (Samsung, Xiaomi, Oppo are the usual offenders). Request the exemption, and
  keep a per-manufacturer instruction page
- **Design for the service dying anyway.** It will. Queue positions locally,
  send on reconnect, and treat a gap in the trail as normal rather than as a
  driver who went missing

---

## 4. What gets stored, and the consent model

This is the sharpest POPIA exposure in the project. Continuous location of an
identifiable person is among the most sensitive categories of personal
information there is, and "we needed to allocate resources" is not on its own a
complete lawful basis.

The design below is what I will build unless you say otherwise. It costs very
little now and is close to impossible to retrofit once there is a year of
trails in the database.

**Consent**
- Explicit and specific at registration — a screen that says what is collected,
  when, why, how long it is kept, and who sees it. Not a tick-box next to terms
- **Withdrawable in the app**, in one obvious place, taking effect immediately
- Re-confirmed each campaign rather than inherited indefinitely

**Collection**
- **Only while on an accepted assignment.** Not background-always, not between
  shifts, not overnight. Accepting an assignment starts it; completing it stops
  it, and so does a timeout
- A visible in-app indicator whenever location is being collected, beyond the
  system notification

**Storage**
- **Snapped to a route segment, not a raw GPS trail.** Allocation needs to know
  a driver is on the N1 near Midrand; it does not need a breadcrumb record of
  their day. Snapping is the single most effective privacy measure here because
  it destroys the surveillance value while keeping the operational value
- Last known position kept at full precision; history kept snapped
- Retention in **days**, purged by the existing nightly job
  (`npm run retention:purge`)

**Use**
- Raw or snapped traces **never** reach the analytics layer or
  `mv_campaign_extract`. The allocation model reads current position and
  travel-time estimates, not history
- Location is never joined to sentiment, ward targeting, or anything about
  voters. The "issues not people" boundary that governs the rest of Xnith is
  not weakened by this layer; it is kept on the other side of a wall
- Access to a named individual's position is role-gated and **logged** — who
  looked, at whom, when

**What is never collected:** location when not on assignment, contacts, call
logs, SMS, installed-app lists, or anything from the device beyond location and
the app's own data. If a future requirement asks for any of those, it needs a
separate conversation, because that is the line between a logistics tool and
something else.

---

## 5. Build order

| Stage | What | Notes |
|---|---|---|
| 5a | Provider registration, service catalogue | Web first. The PWA already covers this |
| 5b | Assignment lifecycle: offered → accepted → en route → on site → complete | Server-side; the app is a client of it |
| 5c | **PWA** for marshals and most providers | No install friction, no APK, instant updates. Covers the majority who never need background tracking |
| 5d | Allocation model — **proposals a human approves** | Never auto-moves people |
| 5e | Allocation dashboard | |
| 5f | Payment export — verified work → instruction file | No money moves through Xnith |
| 5g | **Native APK for drivers** | Gated on §4 being agreed |
| 5h | In-app updater + version endpoint | Ship **with** 5g, not after |
| 5i | Routing via a commercial maps API | `OPEN-QUESTIONS.md` Q9 |

**Why the PWA still exists given the APK decision.** Background location is the
*only* thing that genuinely needs a native app. Marshals filing reports,
volunteers accepting assignments, providers registering — all of that works in
a browser with nothing to install, nothing to sideload, and no update problem.
Pushing every provider through an APK install to deliver features a web page
handles would cost adoption for no gain. So: APK for drivers, who need it; PWA
for everyone else, who do not.

---

## 6. API surface

New routes, following the existing patterns. Writes are role-gated; the app
authenticates as a provider, which is a new role below `reporter`.

```
POST   /api/providers                  register
GET    /api/providers/me               own profile and assignments
PATCH  /api/providers/me/availability  going on/off duty
POST   /api/providers/me/consent       grant or withdraw, append-only record

GET    /api/assignments                for this provider
POST   /api/assignments/:id/accept
POST   /api/assignments/:id/status     en route | on site | complete
POST   /api/assignments/:id/positions  batched positions, snapped server-side

GET    /api/app/version                the updater reads this. Open route
GET    /api/allocation                 command centre: gaps vs available
POST   /api/allocation/propose         model proposals, for a human to approve
GET    /api/payment-export             verified work → instruction file
```

`POST /api/assignments/:id/positions` takes a batch because the device will be
offline intermittently and must be able to send a backlog. It snaps server-side
rather than trusting the client to, so a modified client cannot store a precise
trail by simply not snapping.
