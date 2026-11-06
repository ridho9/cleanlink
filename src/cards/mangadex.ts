// MangaDex: the title page is behind a proof-of-work challenge (302 to
// /edge/challenge) for a browser user agent. The JSON API at api.mangadex.org
// is not, but it sends a browser user agent to the same challenge ("if this
// isn't a browser, don't send a browser UA"), so every request here names the
// bot instead. Two requests, made together: the manga with its cover, author
// and artist, and its statistics.
//
// One embed, by request: cover, title, author, rating, follows (MangaDex calls
// a bookmark a follow), content rating and publication status. A cover rated
// erotica or pornographic is attached behind Discord's spoiler flag, the same
// way as the nhentai cover: an embed image cannot carry that flag.

import {
  authorBlock,
  clip,
  escapeMarkdown,
  getBytes,
  getJson,
  MANGADEX_ORANGE,
  MAX_ATTACH_BYTES,
  statLine,
  toField,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

const API = 'https://api.mangadex.org';
const USER_AGENT = 'cleanlink (+https://github.com/ridho9/cleanlink)';

/** Ratings whose cover goes out spoilered. `safe` and `suggestive` do not. */
const SPOILERED: Record<string, true> = { erotica: true, pornographic: true };

type Tag = { attributes?: { name?: Record<string, string> | null; group?: string | null } | null };
type Relationship = {
  id?: string;
  type?: string;
  attributes?: { name?: string | null; fileName?: string | null } | null;
};
type MangaResponse = {
  result?: string;
  data?: {
    id?: string;
    attributes?: {
      title?: Record<string, string> | null;
      description?: Record<string, string> | null;
      status?: string | null;
      contentRating?: string | null;
      tags?: Tag[] | null;
    } | null;
    relationships?: Relationship[] | null;
  } | null;
};
type StatisticsResponse = {
  statistics?: Record<string, { follows?: number | null; rating?: { average?: number | null } | null } | undefined>;
};

/** A few lines of story keep the card short; the title page has the rest. */
const SYNOPSIS_MAX = 350;
/** Genres and themes only: format ("Oneshot") and content ("Gore") say less. */
const TAG_GROUPS: Record<string, true> = { genre: true, theme: true };
/** A long tag list would push the stats off a phone screen. */
const TAG_MAX = 8;

/** Genres and themes, in the API's order, as one line. */
function tagLine(tags: Tag[] | null | undefined): string | null {
  const names = (tags ?? [])
    .filter((tag) => TAG_GROUPS[tag.attributes?.group ?? ''])
    .map((tag) => tag.attributes?.name?.en)
    .filter((name): name is string => Boolean(name));
  const line = [...new Set(names)].slice(0, TAG_MAX).map(escapeMarkdown).join(' · ');
  return line ? clip(line, 300) : null;
}

/**
 * The synopsis, as the site's own preview shows it: English when there is one,
 * cut at the first `---` or `___` rule. What follows that rule is links and
 * notes ("**Links:** - Official English…"), not the story. The text is
 * MangaDex's own Markdown, written for a Markdown renderer, so it is kept, not
 * escaped: escaping would print its `**` and `[…](…)` literally.
 */
function synopsis(description: Record<string, string> | null | undefined): string | null {
  const text = description?.en ?? Object.values(description ?? {})[0] ?? '';
  const story = text.split(/^\s*(?:-{3,}|_{3,})\s*$/m)[0]!.trim();
  if (story.length <= SYNOPSIS_MAX) return story || null;
  // Cut at the last space, so a word is never broken in half.
  const cut = story.slice(0, SYNOPSIS_MAX);
  const space = cut.search(/\s\S*$/);
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `ongoing` -> `Ongoing`, `pornographic` -> `Pornographic`. */
function label(value: string | null | undefined): string | null {
  return value ? value[0]!.toUpperCase() + value.slice(1) : null;
}

export async function buildMangadexCard({ match }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const id = match[1]!.toLowerCase();
  const api = { ...options, headers: { ...options.headers, 'user-agent': USER_AGENT } };
  const [manga, stats] = await Promise.all([
    getJson<MangaResponse>(`${API}/manga/${id}?includes[]=cover_art&includes[]=author&includes[]=artist`, api),
    getJson<StatisticsResponse>(`${API}/statistics/manga/${id}`, api),
  ]);
  // A missing title answers 404 with `{"result":"error"}`.
  const attributes = manga?.data?.attributes;
  if (manga?.result !== 'ok' || !attributes) return null;

  const relationships = manga.data?.relationships ?? [];
  const title = attributes.title?.en ?? Object.values(attributes.title ?? {})[0] ?? 'MangaDex';
  const url = `https://mangadex.org/title/${id}`;

  // The author first, then the artist when it is someone else.
  const creators = relationships.filter((item) => item.type === 'author' || item.type === 'artist');
  const names = [...new Set(creators.map((item) => item.attributes?.name).filter((name): name is string => Boolean(name)))];
  const firstCreator = creators.find((item) => item.attributes?.name && item.id);

  const stat = stats?.statistics?.[id];
  const average = stat?.rating?.average;
  const lines = [
    [label(attributes.status), label(attributes.contentRating)].filter(Boolean).join(' · '),
    statLine([
      ['⭐', typeof average === 'number' ? average.toFixed(2) : null],
      ['🔖', stat?.follows],
    ]),
  ].filter(Boolean);
  const about = synopsis(attributes.description);
  const tags = tagLine(attributes.tags);

  const embed: CardEmbed = {
    url,
    color: MANGADEX_ORANGE,
    title: toField(title, 256),
    footer: { text: 'MangaDex' },
  };
  if (names.length > 0) {
    embed.author = authorBlock(names.slice(0, 4).map(escapeMarkdown).join(', '), 'MangaDex', {
      url: firstCreator ? `https://mangadex.org/author/${firstCreator.id}` : null,
    });
  }
  const text = [about, tags, lines.join('\n')].filter(Boolean).join('\n\n');
  if (text) embed.description = text;

  // The 512 px rendition: 159 KB against 980 KB for the original, measured,
  // and wider than an embed shows it.
  const file = relationships.find((item) => item.type === 'cover_art')?.attributes?.fileName;
  const cover = file ? `https://uploads.mangadex.org/covers/${id}/${file}.512.jpg` : null;
  if (!cover) return { embeds: [embed], files: [] };

  if (!SPOILERED[attributes.contentRating ?? '']) {
    embed.image = { url: cover };
    return { embeds: [embed], files: [] };
  }

  // Spoilered: only an attachment carries the flag. If it does not fit the
  // message budget, the card goes out without the picture, never unflagged.
  const budget = options.budget ?? {};
  const byteCap = Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES);
  if ((budget.files ?? 1) > 0) {
    const buffer = await getBytes(cover, api, byteCap);
    if (buffer) return { embeds: [embed], files: [{ attachment: buffer, name: 'SPOILER_cover.jpg' }] };
  }
  return { embeds: [embed], files: [] };
}
