// Building the reply: which lines to show, and how to degrade when Discord
// rejects the payload. Split out of bot.js so the ladder can be tested without
// a gateway.

import type { MessageCreateOptions, MessageReplyOptions } from 'discord.js';
import type { Card } from './cards/index.ts';
import type { CardEmbed } from './cards/shared.ts';
import type { CleanedLink } from './clean.ts';
import { note } from './trace.ts';

export interface ReplyTarget<T> {
  reply: (payload: MessageReplyOptions) => Promise<T>;
  channel: { send: (payload: MessageCreateOptions) => Promise<T> };
}

const MESSAGE_LIMIT = 2000;

/** Keep whole lines only, so a URL is never cut in half. */
export function fitLines(lines: string[], max = MESSAGE_LIMIT) {
  const kept = [];
  let length = 0;
  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (length + cost > max) break;
    kept.push(line);
    length += cost;
  }
  return kept;
}

/** An embed whose image came from a file we are no longer sending. */
function withoutAttachmentImages(embed: CardEmbed) {
  if (!embed.image?.url?.startsWith('attachment://')) return embed;
  const copy = { ...embed };
  delete copy.image;
  return copy;
}

/** False for an embed that only existed to show one of those images. */
function hasContent(embed: CardEmbed) {
  return Boolean(
    embed.title ||
      embed.description ||
      embed.author ||
      embed.footer ||
      embed.image ||
      embed.fields?.length,
  );
}

/**
 * Post the reply, degrading step by step.
 *
 * `onSent` is called with every message posted (the reply and each
 * follow-up), so the caller can delete them along with the original.
 *
 * A card is decoration: a rejected attachment or a missing Embed Links
 * permission must never cost the clean link itself.
 */
export async function sendReply<T>(
  message: ReplyTarget<T>,
  { lines, cards }: { lines: CleanedLink[]; cards: Card[] },
  { onSent = async () => {} }: { onSent?: (sent: T) => Promise<unknown> } = {},
) {
  const carded = new Set(cards.map((card) => card.from));
  const content = fitLines([
    // One line per card, the link in angle brackets so Discord does not unfurl
    // it a second time next to the card. A card that hands the link over
    // (`unfurl`) is the opposite: its URL is the preview, so it goes bare.
    ...cards.map((card) => (card.unfurl ? card.url : `<${card.url}>`)),
    ...lines.filter(({ from }) => !carded.has(from)).map(({ to }) => to),
  ]).join('\n');

  const files = cards.flatMap((card) => card.files ?? []);
  const embeds = cards.flatMap((card) => card.embeds);

  const full: MessageReplyOptions = { content, allowedMentions: { parse: [] } };
  if (embeds.length > 0) full.embeds = embeds;
  if (files.length > 0) full.files = files;

  const attempts = [full];
  if (files.length > 0) {
    attempts.push({
      content,
      allowedMentions: { parse: [] },
      // Image-only embeds have nothing left to show once their file is gone.
      embeds: embeds.map(withoutAttachmentImages).filter(hasContent),
    });
  }
  if (embeds.length > 0) {
    attempts.push({ content: content.replace(/[<>]/g, ''), allowedMentions: { parse: [] } });
  }

  for (const [index, payload] of attempts.entries()) {
    try {
      await onSent(await message.reply(payload));
      break;
    } catch (error) {
      const last = index === attempts.length - 1;
      if (last) throw error;
      note(`[reply] attempt ${index + 1} rejected: ${(error as Error).message}`);
    }
  }

  await sendFollowUps(message, cards, onSent);
}

/** At most this many follow-up messages, so a five-link message stays a reply. */
const MAX_FOLLOW_UPS = 2;
const FOLLOW_UP_LABEL = '▶ Play video';

/**
 * Post the media that could not ride along with the card.
 *
 * A video only plays in Discord when it is a file attachment or when Discord
 * unfurls a bare URL - and any embed in the message suppresses the unfurl. So
 * when the file is too large to upload, the media URL goes out on its own, as
 * a second message: no upload, no size limit.
 *
 * The URL is masked behind a label. A signed CDN URL runs past 1000 characters
 * and Discord prints it in full above the player; a masked link still unfurls
 * into the same player (measured for Instagram and X).
 */
async function sendFollowUps<T>(message: ReplyTarget<T>, cards: Card[], onSent: (sent: T) => Promise<unknown>) {
  const urls = cards.map((card) => card.followUp).filter((url): url is string => Boolean(url)).slice(0, MAX_FOLLOW_UPS);

  for (const url of urls) {
    try {
      await onSent(await message.channel.send({ content: `[${FOLLOW_UP_LABEL}](${url})`, allowedMentions: { parse: [] } }));
      note(`[reply] follow-up with ${new URL(url).host}`);
    } catch (error) {
      // The clean link and the card are already out; a lost player is not worth
      // a stack trace, but it is worth a line in the log.
      note(`[reply] follow-up failed: ${(error as Error).message}`);
    }
  }
}

export { withoutAttachmentImages, hasContent };
