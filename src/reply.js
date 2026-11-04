// Building the reply: which lines to show, and how to degrade when Discord
// rejects the payload. Split out of bot.js so the ladder can be tested without
// a gateway.

const MESSAGE_LIMIT = 2000;

/** Keep whole lines only, so a URL is never cut in half. */
export function fitLines(lines, max = MESSAGE_LIMIT) {
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
function withoutAttachmentImages(embed) {
  if (!embed.image?.url?.startsWith('attachment://')) return embed;
  const copy = { ...embed };
  delete copy.image;
  return copy;
}

/** False for an embed that only existed to show one of those images. */
function hasContent(embed) {
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
 * A card is decoration: a rejected attachment or a missing Embed Links
 * permission must never cost the clean link itself.
 */
export async function sendReply(message, { lines, cards }) {
  const carded = new Set(cards.map((card) => card.from));
  const content = fitLines([
    // One line per card: the bracketed link, then anything the builder asked to
    // have beside it. Angle brackets stop Discord from unfurling the carded
    // link a second time; the extra links are meant to unfurl (that is how a
    // playable video gets in, since an embed's video field is dropped).
    ...cards.map((card) => [`<${card.url}>`, ...(card.extraLines ?? [])].join(' ')),
    ...lines.filter(({ from }) => !carded.has(from)).map(({ to }) => to),
  ]).join('\n');

  const files = cards.flatMap((card) => card.files ?? []);
  const embeds = cards.flatMap((card) => card.embeds);

  const full = { content, allowedMentions: { parse: [] } };
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
      await message.reply(payload);
      return;
    } catch (error) {
      const last = index === attempts.length - 1;
      if (last) throw error;
      console.log(`[reply] attempt ${index + 1} rejected: ${error.message}`);
    }
  }
}

export { withoutAttachmentImages, hasContent };
