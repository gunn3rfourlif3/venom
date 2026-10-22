-- Local press is closed, and it is the most expensive closure in the project.
--
-- The 22 Gauteng community titles were the finest-grained source Xnith had.
-- They cover single suburbs — Pimville, Katlehong, Ga-Rankuwa, Meyerton — at
-- a geography no hashtag or national feed reaches, and DATA-SOURCES.md
-- recommended expanding them to 100+ titles nationally. That recommendation
-- is void.
--
-- WHAT HAPPENED, traced on 22 October after all 22 returned HTTP 403:
--
--   albertonrecord.co.za/feed/            301
--     -> www.citizen.co.za/alberton-record/feed/   403
--
-- The Caxton titles have been consolidated onto citizen.co.za, which sits
-- behind Cloudflare bot management. Every non-browser client is refused:
-- the project's own user-agent, a plain identifying one, and no user-agent
-- at all all return 403. `citizen.co.za/robots.txt` cannot even be READ —
-- it returns a managed challenge page demanding JavaScript and cookies.
--
-- So the publisher's machine-readable policy is unreadable by machines, and
-- the only way to reach the feeds is to solve a bot challenge.
--
-- THAT IS THE LINE. Passing a Cloudflare challenge with a headless browser
-- would work, and it is the same act as scraping Facebook: going around an
-- access-control decision rather than through it. The decision does not bend
-- because this source is more useful to us than that one was. Marked CLOSED
-- for the same reason facebook and tiktok are, and by the same rule.
--
-- THE ROUTE THAT IS OPEN is a conversation, not a client: Caxton/The Citizen
-- can grant feed or syndication access, and a party asking a publisher for
-- its RSS is an ordinary request that can be made in the open. Until someone
-- asks, this is closed.
--
-- NOTE the old domains' robots.txt still says `Allow: /`. That is the policy
-- of a host that now only issues redirects, so it describes nothing. A
-- robots.txt on a domain that no longer serves content is not permission.

UPDATE source
   SET access  = 'CLOSED',
       enabled = false,
       notes   = 'Caxton titles consolidated onto citizen.co.za, behind '
                 || 'Cloudflare bot management. All user-agents 403; robots.txt '
                 || 'itself returns a JS challenge. Reaching the feeds would '
                 || 'require solving a bot challenge, which is circumvention. '
                 || 'Open route: ask Caxton/The Citizen for syndication access.'
 WHERE source_id = 'local_press';
