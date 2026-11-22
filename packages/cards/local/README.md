# Local card set

This folder holds a private card set, such as the real cards from your own physical copy. **Never commit its contents.** Git ignores everything here except this README.

## Files

Put all seven files here, each a JSON array of card definitions in the same format as `../data/` (TECHNICAL_DESIGN.md §5.7):

- `leaders.json`
- `heroes.json`
- `items.json`
- `magic.json`
- `modifiers.json`
- `challenges.json`
- `monsters.json`

An empty file holds `[]`. No other JSON files may sit here.

## How it is used

When any of these files exist, the client plays with this set instead of the placeholder cards, and the lobby says "Local cards". With none of them, it uses the placeholder cards and the lobby says "Placeholder cards".

The set is validated when the client starts. A missing or unknown file, or a mistake in a card, stops it with the file, or the card and the field, named.

Saves and replays record which card definitions they were made with, so ones made with this set won't load with the placeholder set, and the other way round.
