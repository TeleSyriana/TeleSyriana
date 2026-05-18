# Phase 15 — Language Switcher

## Added
- Added a visible language selector inside Settings.
- Supports Arabic and English.
- Saves selected language locally and in `userProfiles` when Firestore is available.
- Applies `lang` and `dir` on the HTML document:
  - Arabic = RTL
  - English = LTR
- Translates core navigation, login screen, settings labels, theme/background options, and logout label.
- Keeps technical fields readable in LTR where needed.

## Notes
- Some deeper module text is still static inside module files. This phase adds the language foundation and covers the main UI.
- Full module-level translation can be added later by moving all labels to one i18n dictionary.
- Firestore still needs to be created for cross-device saving.
