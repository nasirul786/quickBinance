export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Clickable HTML mention for a Telegram user (row from `users` or a Telegram `User`). */
export function mention(user) {
  const id = user.telegram_id ?? user.id;
  const name = user.username ? `@${user.username}` : user.first_name || `user ${id}`;
  return `<a href="tg://user?id=${id}">${escapeHtml(name)}</a>`;
}

export const isPrivate = (ctx) => ctx.chat?.type === 'private';

/** Split command arguments on whitespace, keeping the untouched remainder available. */
export function splitArgs(text, count) {
  const parts = [];
  let rest = text.trim();
  for (let i = 0; i < count && rest; i++) {
    const match = rest.match(/^(\S+)\s*/);
    parts.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return { parts, rest };
}
