// Per-site cleaning rules. Data only — the engine lives in clean.js.
//
// hosts:     base domains. A URL matches if its hostname equals one of these
//            or ends with ".<host>" (so www./m./vm. subdomains match too).
// share:     when the pathname matches, the URL is an opaque share link and
//            must be resolved via its redirect before cleaning.
// shorten:   exact hosts that are pure redirectors (never the final URL).
// drop:      query parameters to remove (regex, tested against the name).
//            Common trackers (utm_*, fbclid, ...) are dropped for every site.
// ua:        optional override of the request user agent. The engine default
//            is the bare "Mozilla/5.0", which is what these sites hand a
//            redirect to.
// failure:   resolved URLs that mean "the code was invalid" rather than a
//            real target. The engine also rejects root/parent-path redirects.
//
// Kept deliberately small: the sites below have been confirmed against real
// links. Reddit, Spotify and Google were dropped until someone checks them
// with a live link each.

export const RULES = [
  {
    id: 'threads',
    hosts: ['threads.com', 'threads.net'],
    share: /^\/(?:share|t)\/[A-Za-z0-9_-]+\/?$/i,
    dropAllOn: /\/post\/[A-Za-z0-9_-]+/i,
    drop: [/^xmt$/i, /^slof$/i],
  },
  {
    id: 'instagram',
    hosts: ['instagram.com', 'instagr.am'],
    share: /^\/share\//i,
    dropAllOn: /^\/(?:p|reel|reels|tv)\//i,
    // mdxt/psln are the newer share tokens; igsh/igshid are the older ones.
    drop: [/^igsh$/i, /^igshid$/i, /^mdxt$/i, /^psln$/i],
  },
  {
    id: 'tiktok',
    hosts: ['tiktok.com'],
    shorten: ['vm.tiktok.com', 'vt.tiktok.com'],
    dropAllOn: /\/video\/\d+/i,
    // `_t` is the share token the shortener appends to its target.
    drop: [
      /^is_from_webapp$/i,
      /^sender_device$/i,
      /^web_id$/i,
      /^_r$/i,
      /^_t$/i,
      /^share_app_id$/i,
      /^share_link_id$/i,
    ],
  },
  {
    id: 'twitter',
    hosts: ['twitter.com', 'x.com'],
    // `s`, `t` and `a` are per-share tokens; the list only matters for
    // non-permalink URLs, since status links drop the whole query.
    dropAllOn: /\/status\/\d+/i,
    drop: [/^s$/i, /^t$/i, /^a$/i, /^ref_src$/i, /^ref_url$/i],
  },
  {
    id: 'youtube',
    hosts: ['youtube.com', 'youtu.be'],
    drop: [/^si$/i, /^feature$/i],
    // A watch link carries the video in `v` and nothing else that matters:
    // `list`, `index`, `start_radio`, `pp` and `ab_channel` are all decoration.
    // Scoped to the watch path so `youtube.com/results?search_query=…` and
    // `/playlist?list=…` keep their parameters.
    keepOnly: { path: /^\/watch\/?$/, keep: [/^v$/i] },
  },
  {
    id: 'facebook',
    hosts: ['facebook.com', 'fb.com', 'fb.watch'],
    shorten: ['fb.watch'],
    share: /^\/share\//i,
    dropAllOn: /\/(?:posts|permalink|videos|reel)\b/i,
    // share_url is the back-reference to the share link we just unwrapped.
    drop: [/^rdid$/i, /^refid$/i, /^sfnsn$/i, /^__tn__$/i, /^share_url$/i],
    // An invalid fb.watch code lands on the watch page with no video id.
    failure: [/^https:\/\/(?:www\.)?facebook\.com\/watch\/?\??$/],
  },
];
