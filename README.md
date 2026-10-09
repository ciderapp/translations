# Cider Translations

Community translation files for [Cider](https://cider.sh)

<p align="center">
  <br/>
  <a href="../../issues/new?template=translation.yml">
    <img alt="Suggest a translation" src="https://img.shields.io/badge/Suggest%20a%20translation-2EA44F?style=for-the-badge&logo=github&logoColor=white">
  </a>
  <br/>
  <sub>No fork, no PR, no command line. Fill in a short form; a maintainer reviews and the bot does the rest.</sub>
  <br/><br/>
</p>

<p align="center">
  <a href="../../actions/workflows/ai-fill.yml"><img alt="AI fill" src="https://img.shields.io/github/actions/workflow/status/ciderapp/translations/ai-fill.yml?branch=main&label=AI%20fill&style=flat-square"></a>
  <a href="../../actions/workflows/translation-issue.yml"><img alt="Issue bot" src="https://img.shields.io/github/actions/workflow/status/ciderapp/translations/translation-issue.yml?branch=main&label=Issue%20bot&style=flat-square"></a>
  <a href="locales/languages.yml"><img alt="Languages" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fciderapp%2Ftranslations%2Fmain%2F.github%2Fbadges%2Flanguages.json&style=flat-square"></a>
  <a href="#translators"><img alt="Translators" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fciderapp%2Ftranslations%2Fmain%2F.github%2Fbadges%2Ftranslators.json&style=flat-square"></a>
</p>

---

This repository holds every locale Cider ships, on desktop and on Android. **The English source (`locales/en-US.yml`) is generated automatically** from the two codebases; you can read it but please don't edit it here. Every other locale is fair game.

## How translations work

Three things keep this repo healthy:

1. **The apps mirror their English here.** Whenever Cider's desktop code (Citadel) or Cider for Android adds or changes a translatable string, its sync workflow updates its own keys in `en-US.yml` (see [Two apps, one file](#two-apps-one-file)).
2. **AI fills new strings.** When `en-US.yml` changes, [`.github/workflows/ai-fill.yml`](.github/workflows/ai-fill.yml) runs Anthropic Claude (specifically Haiku 5.5, model id `claude-haiku-5-5`) against the delta, one job per language, and commits each language as soon as it's done. The shared system prompt (rules and glossary) is sent with Anthropic prompt caching so later batches in the same job read that prefix from cache. Per-batch English strings are not cached. Each request logs `cache_creation_input_tokens` and `cache_read_input_tokens`.
3. **Humans correct what the AI gets wrong.** Open a [translation issue](../../issues/new?template=translation.yml) with the corrections, a maintainer labels it `approved`, and a bot applies the change with full credit attached.

## Where to look

| File / directory | What it is |
| --- | --- |
| [`locales/en-US.yml`](locales/en-US.yml) | English source. **Read-only here**; edits get overwritten by the app syncs. |
| `locales/<code>.yml` | One file per target language. This is where translations live. |
| [`locales/languages.yml`](locales/languages.yml) | Locked list of supported languages with display names. |
| [`scripts/i18n-translate.mjs`](scripts/i18n-translate.mjs) | The AI translator (Anthropic Claude Haiku 5.5, with prompt caching on the shared rules prefix). Runs in CI; you generally won't run it locally. Needs `ANTHROPIC_API_KEY`. |
| [`.github/ISSUE_TEMPLATE/translation.yml`](.github/ISSUE_TEMPLATE/translation.yml) | The contribution form. |
| [`i18n/owners.yml`](i18n/owners.yml) | Which app owns which keys of `en-US.yml`. |
| `i18n/fill-state/<code>.yml` | Bookkeeping for the AI fill: which English each translation was made from. Written by the bots. |
| `i18n/consumers/<app>.yml` | Desktop keys the Android app also reads. Written by the Android sync. |
| [`scripts/i18n-sync-source.mjs`](scripts/i18n-sync-source.mjs) | What each app's sync runs to update its own keys in `en-US.yml`. |

## File format

Translation files are YAML. Each key maps to either a scalar (AI-translated) or a map (community-contributed, with credit).

```yaml
# Scalar = AI-translated. May be re-translated automatically if the English source changes.
action.apply: Aplicar

# Map = community-contributed. The bot writes this shape after a maintainer approves an issue.
action.back:
  value: Atrás
  source: human
  by: '@yourhandle'
  issue: 1234
```

The runtime reads `value` (or the scalar). The extra fields are credit metadata.

When an AI re-translation overwrites a human entry (because the English source changed), the map is preserved with `source: ai` and a `superseded_at` date, so credit isn't lost. The original contributor is notified on the issue thread.

## Two apps, one file

Cider for desktop and Cider for Android share these locale files. Keys starting with `mobile.` belong to the Android app; every other key belongs to desktop ([`i18n/owners.yml`](i18n/owners.yml)). Each app's sync replaces only its own keys in `en-US.yml`, so neither can delete the other's strings, and they can land in either order.

Android's strings use [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/), which handles plurals properly:

```yaml
mobile.library.songCount: "{count, plural, one {# song} other {# songs}}"
mobile.playlist.addedTo: Added to {playlist}
```

When translating them, keep every `{argument}` name as it is, translate only the text inside each plural branch, and add the plural forms your language needs (`few`, `many`). A straight apostrophe right before `{` hides the placeholder (`l'{playlist}` prints `{playlist}`), so use the typographic one (`l’{playlist}`). The bot checks all of this.

An Android string with the same English as a desktop string reuses the desktop translation, so a correction to one helps both.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: **open an issue**, don't open a PR, the bot does PRs so attribution stays consistent.

## Translators

Every entry below came from a community member through a [translation issue](../../issues/new?template=translation.yml). Thank you! Contributors are also credited as the git author of the commit that applied their work, so this same crew shows up in the [contributors graph](../../graphs/contributors).

<!-- table auto-generated by scripts/update-credits.mjs — do not edit by hand -->
<!-- translators:start -->
| Translator | Languages | Entries |
| --- | --- | --- |
| [@Tesutarin](https://github.com/Tesutarin) | Chinese (Simplified) | 2367 |
| [@jay900604](https://github.com/jay900604) | Chinese (Hong Kong), Chinese (Simplified), Chinese (Traditional) | 1010 |
| [@kinlay0](https://github.com/kinlay0) | Russian | 222 |
| [@szymin22](https://github.com/szymin22) | Polish | 111 |
| [@Vudgekek](https://github.com/Vudgekek) | Croatian | 103 |
| [@lumaa-dev](https://github.com/lumaa-dev) | French | 68 |
| [@nekocats](https://github.com/nekocats) | Estonian | 42 |
| [@MP-K](https://github.com/MP-K) | Korean | 27 |
| [@ramuuflor](https://github.com/ramuuflor) | Japanese | 22 |
| [@itsmeares](https://github.com/itsmeares) | Turkish | 16 |
| [@emirasaf](https://github.com/emirasaf) | Turkish | 11 |
| [@felipecadal](https://github.com/felipecadal) | Portuguese (Brazil) | 1 |
| [@UnoPanduo](https://github.com/UnoPanduo) | Dutch | 1 |
| [@yako0755](https://github.com/yako0755) | Japanese | 1 |
<!-- translators:end -->

## License

Translation content is contributed under the terms outlined in [CONTRIBUTING.md](CONTRIBUTING.md). Cider itself is closed-source; this repository exists to keep translation work in the open.
