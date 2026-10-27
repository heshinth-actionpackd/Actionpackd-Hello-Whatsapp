# GENERAL PRINCIPLES

- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.

# Codebase
- Keep all files around 300 lines of code as much as possible (Auto added files such as Shadcn/UI components can be given an exception). If a file exceeds this limit, consider splitting it into smaller modules. — but don't shatter code into fragments either; a file holds one coherent  concern.
- Files must be modular and single purpose. Avoid mixing unrelated functionality in the same file.
- Follow the Conventional Commits specification for commit messages.
- Update the README.MD whenever is a change.
- **Naming**: clear, descriptive names that read as plain English —
  `remainingAttempts` over `rem`, `decodeStemFile()` over `procF()`. Abbreviations
  only when universally understood (`id`, `url`, `config`).