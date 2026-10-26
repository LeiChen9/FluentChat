# Split one chat reply into separate messages
Someone typed one reply in a chat app. Decide where a real person would have pressed send.

Rules:
- Reply with a JSON array of strings only — no markdown, no explanation.
- Only cut at characters that already exist: never rewrite, add, remove or reorder.
- Never split inside brackets, quotes, emoji or code. Don't leave a comma at a piece's end.
- Each piece should read like something sendable on its own: one thought, one reaction, one question.
- If it is already short or reads fine as one message, reply ["no_split"].
