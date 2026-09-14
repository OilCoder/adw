# Structure (applies to every project, any language)

The repository must stay readable by a person who has never seen it. Order is
not optional and is not decided per task: the supervisor fixes it once in
`.codegen/structure.md` (the map) and every contract obeys it.

## Fixed folders, present in every project

- `.codex/`, `.codegen/`: the code-generation system. Never product code.
- `docs/`: the project website deployed with GitHub Pages. Never product code.
- `wiki/`: the project documentation for people and agents. Three fixed
  subfolders: `wiki/idea/` (the idea, seven files, rules in
  `.codex/instructions/idea.md`), `wiki/audits/<stamp>/` (sessions
  recorded while testing the app: `notes.md` and `img/`), and
  `wiki/changes/<name>/` (change proposals and their delta on the idea;
  `wiki/changes/archive/` once landed).
- `data/`: input data, when the project has any.
- Everything else is declared in the map before it exists.

## Principles

1. **One folder per concept or domain**, never per file type. Everything about
   one topic lives together; a reader finds a feature by opening one folder.
2. **One responsibility per file, named after it.** No `utils`, `misc`,
   `helpers`, `common`, `stuff`, or `index` files used as a drawer. An `index`
   only re-exports.
3. **One language and one naming convention for the whole project**, chosen in
   the map (identifiers, files, comments, UI text). No mixing.
4. **Tests, scripts, generated output and fixtures each have one fixed home**,
   named in the map. Tests mirror the folder of what they test.
5. **A task touches one domain.** A contract that needs two domains is split
   in two. A new domain is added to the map first, then built.
6. **Order of execution is visible in the name** when files run in sequence
   (`01_ingest`, `02_clean`); the number sorts, it does not create dependencies.
7. **Nothing provisional.** No placeholders, `.tmp`, `.bak`, `TODO` files,
   commented-out blocks, or two files with the same name in different folders.
8. **Smallest change that meets the contract.** Reuse what exists; do not add
   a dependency the map does not list; do not build for imagined futures.
9. **Growth is paid for.** A new module, state, option, flag or abstraction
   enters only when a concrete failure or requirement asks for it, and the
   contract names what it replaces or why nothing existing serves. Two
   places doing the same thing become one before a third appears.

## The map (`.codegen/structure.md`, written by the supervisor, approved by the user)

- Every top-level folder with its responsibility in one line.
- The domains and the folder that hosts each one.
- Naming convention for this language (files, identifiers, components).
- The language of code, comments and UI text.
- Where tests, scripts, fixtures and generated files live.
- The dependencies the project may use.

A contract's `allowed_to_modify` is derived from the map. The gate rejects any
file outside the map, any provisional file, and any duplicated file name.
