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
  <a href="../../actions/workflows/ai-fill.yml">
    <img alt="AI fill" src="https://img.shields.io/github/actions/workflow/status/ciderapp/translations/ai-fill.yml?branch=main&label=AI%20fill&style=flat-square">
  </a>
  <a href="../../actions/workflows/translation-issue.yml">
    <img alt="Issue bot" src="https://img.shields.io/github/actions/workflow/status/ciderapp/translations/translation-issue.yml?branch=main&label=Issue%20bot&style=flat-square">
  </a>
  <a href="locales/languages.yml">
    <img alt="Languages" src="https://img.shields.io/badge/languages-30-blue?style=flat-square">
  </a>
  <a href="../../graphs/contributors">
    <img alt="Contributors" src="https://img.shields.io/github/contributors/ciderapp/translations?style=flat-square&color=blue">
  </a>
</p>

---

This repository holds every locale Cider ships. **The English source (`locales/en-US.yml`) is generated automatically** from the Cider codebase; you can read it but please don't edit it here. Every other locale is fair game.

## How translations work

Three things keep this repo healthy:

1. **Citadel mirrors `en-US.yml` here.** Whenever Cider's source code adds or changes a translatable string, a sync workflow pushes the updated `en-US.yml` into this repo.
2. **AI fills new strings.** When `en-US.yml` changes, [`.github/workflows/ai-fill.yml`](.github/workflows/ai-fill.yml) runs Google Gemini (specifically 3.5 Flash) against the delta and commits translations for every supported language.
3. **Humans correct what the AI gets wrong.** Open a [translation issue](../../issues/new?template=translation.yml) with the corrections, a maintainer labels it `approved`, and a bot applies the change with full credit attached.

## Where to look

| File / directory | What it is |
| --- | --- |
| [`locales/en-US.yml`](locales/en-US.yml) | English source. **Read-only here**; edits get overwritten by the Citadel sync. |
| `locales/<code>.yml` | One file per target language. This is where translations live. |
| [`locales/languages.yml`](locales/languages.yml) | Locked list of supported languages with display names. |
| [`scripts/i18n-translate.mjs`](scripts/i18n-translate.mjs) | The AI translator (Gemini). Runs in CI; you generally won't run it locally. |
| [`.github/ISSUE_TEMPLATE/translation.yml`](.github/ISSUE_TEMPLATE/translation.yml) | The contribution form. |

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: **open an issue**, don't open a PR, the bot does PRs so attribution stays consistent.

## License

Translation content is contributed under the terms outlined in [CONTRIBUTING.md](CONTRIBUTING.md). Cider itself is closed-source; this repository exists to keep translation work in the open.
