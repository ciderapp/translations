# Contributing translations

Translations come in via **issues**, not pull requests. A bot does the actual file edits; that keeps attribution consistent and lets the AI translator know which entries are human-owned.

## How to contribute

1. [**Open a translation issue**](../../issues/new?template=translation.yml).
2. Fill in:
   - **Language code** (e.g. `es`, `pt-BR`, `zh-CN`, `is`). Prefer one from [`locales/languages.yml`](locales/languages.yml). A new BCP-47 code is fine; a maintainer has to approve before the locale is created.
   - If the YAML does not fit in the form, attach a `.yml` file to the issue. The bot reads GitHub user-attachments from that same issue.
   - **Translations**, one per line as `key.path: Translated text`.
   - **Notes** if you have context worth sharing.
3. The bot validates and posts a preview comment within ~1 minute.
4. A maintainer reviews and labels the issue `approved`.
5. The bot commits your translation with `source: human, by: '@you', issue: N` attached. The issue closes automatically.

If the bot reports a validation error, edit the issue body and the check re-runs.

## What the bot validates

- The language code is a valid BCP-47 tag. Codes already in `locales/languages.yml` apply as usual. An unknown code is a new-language request: only a maintainer (write/maintain/admin) can create it, by labeling the issue `approved` or by running **Actions > Add locale**.
- Every key you reference is in `locales/en-US.yml`.
- Placeholders are preserved exactly. If the English is `Loading {n} tracks…`, your translation must contain `{n}`. Recognised forms: `{n}`, `{0}`, `${variable}`, `$VARIABLE`, `{{ variable }}`, `{{variable}}`.
- Proper nouns aren't translated: Cider, Apple Music, AirPlay, Dolby Atmos, Chromecast, AudioLab, ListenBrainz, Last.fm, Maloja, Discord.
- Keys starting with `mobile.` (Cider for Android) are ICU MessageFormat. Your translation has to parse: keep the braces and `{argument}` names exactly, translate only the text inside plural branches, and use the typographic apostrophe (`’`) next to a placeholder, never a straight one. Leaving out an argument on purpose is fine; renaming one isn't.

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

If your language isn't in [`locales/languages.yml`](locales/languages.yml):

1. Open a translation issue with the BCP-47 **Language code** (e.g. `is`) and the English **Language name** (or title it `[language] Add Icelandic`).
2. Paste keys, or attach a `.yml` file if the file is too large for GitHub's issue body.
3. A maintainer with write access labels the issue `approved`, or runs **Actions > Add locale** with the code, name, and issue number.

The bot registers the language here, writes `locales/<code>.yml` with your strings, and leaves missing keys unset so Cider falls back to English. AI fill then translates the rest.

`locales/languages.yml` is still snapshotted from Citadel on each desktop sync. That used to overwrite languages added only here (Croatian on 2026-05-25, Estonian on 2026-06-08). The sync now **merges**: codes that exist here and not in Citadel's snapshot are kept. The in-app language picker still reads Citadel, so a maintainer should add the same code to `ciderapp/citadel`'s `locales/languages.yml` when it should show up in Cider.

## What lives where

- This repo: every locale file, the language list, the AI translator, the issue bot.
- The Cider source repos (desktop and Android): the English string keys (extracted automatically) and the runtimes that consume translations.
- You don't need access to the Cider repo to contribute translations.

## Conduct

Be specific. Assume good faith. Disagreement on translation is welcome; snark isn't.

## Security

Don't report security issues through the translation form. See [SECURITY.md](SECURITY.md) for the private disclosure path.
