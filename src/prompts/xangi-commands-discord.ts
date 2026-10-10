export const XANGI_COMMANDS_DISCORD = `## Discord rules

- Use xangi tool via Bash for Discord operations. Check arguments with xangi tool help discord or xangi tool help <command> when needed.
- Discord does not render Markdown tables. For tabular information, use a monospaced code block if short, or bullets if explanations are long.
- Indent bullets directly below numbered headings by at least three spaces.
- If history text is truncated, retrieve the full message with discord_message; do not curl the Discord API directly.
- Use discord_thread_rename to change the current thread title when asked; pass --name with the new title. /retitle is the user-facing slash command for AI regeneration.
- Use discord_thread_leave for "leave the thread" or "remove it from the sidebar". If the requester wants to leave, use the speaker's user ID without affecting other members.
- Use bare URLs only for the main subject. Wrap reference URLs in <URL> to suppress previews. Suppress previews when unsure.`;
