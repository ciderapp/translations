# Contributing translations

Translations come in via **issues**, not pull requests. A bot does the actual file edits; that keeps attribution consistent and lets the AI translator know which entries are human-owned.

## How to contribute

1. [**Open a translation issue**](../../issues/new?template=translation.yml).
2. Fill in:
   - **Language code** (e.g. `es`, `pt-BR`, `zh-CN`). Pick one from [`locales/languages.yml`](locales/languages.yml).
   - **Translations**, one per line as `key.path: Translated text`.
   - **Notes** if you have context worth sharing.
3. The bot validates and posts a preview comment within ~1 minute.
4. A maintainer reviews and labels the issue `approved`.
5. The bot commits your translation with `source: human, by: '@you', issue: N` attached. The issue closes automatically.

If the bot reports a validation error, edit the issue body and the check re-runs.

## What the bot validates

- The language code is in `locales/languages.yml`.
- Every key you reference is in `locales/en-US.yml`.
- Placeholders are preserved exactly. If the English is `Loading {n} tracks…`, your translation must contain `{n}`. Recognised forms: `{n}`, `{0}`, `${variable}`, `$VARIABLE`, `{{ variable }}`, `{{variable}}`.
- Proper nouns aren't translated: Cider, Apple Music, AirPlay, Dolby Atmos, Chromecast, AudioLab, ListenBrainz, Last.fm, Maloja, Discord.

## Tone

Cider follows Apple Music's house style.

- Clean, friendly, not too casual.
- Use the formal "you" for system messages where the language has one (German `Sie`, French `vous`, Italian `Lei`). Informal for greetings and short labels (`Hola`, `Bonjour`).
- Keep button labels short. They sit in tight UI.
- Match the register of Apple Music's own translations where you can. Users will compare side by side.

## When the English source changes

If a string's English text changes after you translate it, the AI re-translates it. That's intentional; the old human translation was for the old English. You'll get pinged on the original issue thread when this happens and can file a new issue with a corrected version.

Your name stays attached in the YAML even after an AI re-translation (`source: ai` plus the original `by` and `issue` fields), so credit isn't lost.

## Adding a new language

If your language isn't in [`locales/languages.yml`](locales/languages.yml), open an issue titled `[language] Add <Name>` with:

- The locale code (BCP-47, e.g. `eu` for Basque, `mt` for Maltese).
- The endonym (the language's name in its own script).
- Why it should be added (target audience size, Apple Music availability, etc.).

A maintainer adds it on the Cider side. The next sync pushes the new language here and the AI seeds the initial translation. You can then contribute corrections normally.

## What lives where

- This repo: every locale file, the language list, the AI translator, the issue bot.
- The Cider source repo: the English string keys (extracted automatically) and the runtime that consumes translations.
- You don't need access to the Cider repo to contribute translations.

## Conduct

Be specific. Assume good faith. Disagreement on translation is welcome; snark isn't.

## Security

Don't report security issues through the translation form. See [SECURITY.md](SECURITY.md) for the private disclosure path.
