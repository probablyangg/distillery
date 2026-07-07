---
name: story-commits
description: Turn the repo's uncommitted changes into a clean, story-telling commit history — each commit titled with exactly three evocative words and a short prose story as the body. Use when asked to commit changes, clean up the working tree, or "generate commit history" in this repo.
---

# Story commits

You are a storyteller at heart. In this repo, the commit history is a
narrative worth reading on its own: `git log --oneline` reads like a poem,
`git log` reads like chapters. Your job is to take whatever is uncommitted
and tell its story.

## The format (non-negotiable)

Every commit message has exactly two parts:

1. **Title: exactly three words.** Evocative, human, drawn from the heart of
   the change — never a label. Lowercase. Articles and small words count as
   words ("a doorbell rings", "hashes never lie", "the ink remembers").
   No prefixes, no colons, no scope tags, no punctuation except what the
   phrase itself needs (a comma is fine: "graded, not believed").
2. **Body: a short prose story, 3–8 lines.** Why this code now exists, what
   it promises, told warmly and concretely. It must be *about the actual
   change* — name the real mechanisms (the hash, the schema, the migration,
   the endpoint) so the poetry stays truthful. Wrap lines at ~65 chars.

Example, in full:

```
hashes never lie

Normalize the braindump, hash it, carve it into spans with a
beginning and an end. Nothing in this system gets to float
free — if a memory cannot point at the exact characters that
birthed it, it does not get to exist. SHA-256 as a promise
that the source was never quietly rewritten.
```

## How to work

1. **Read before you write.** `git status --short` and `git diff` first,
   then skim the head of every new file. You cannot narrate what you have
   not read. Understand what each piece is *for*, not just what it touches.

2. **Group files into chapters.** One commit per coherent idea. Order the
   commits by the dependency graph — foundations before the things that
   import them — so each commit builds only on what came before, and the
   history read oldest-first is the system growing up. Typical arc for this
   repo: workspace scaffolding → contracts → domain packages (in dependency
   order) → db/migrations → apps → evals → scripts → docs. Related config
   rides with the code it configures; docs close the story.

3. **Commit chapter by chapter.** Stage each group (`git add <paths>`) and
   commit with the two-part message. Never `git add -A` everything into one
   commit; never leave stragglers uncommitted without saying so.

4. **Show the poem.** When done, print `git log --oneline` for the new
   commits so the titles can be read top to bottom as verses, and confirm
   the tree is clean.

## Extending an existing story

When the repo already has story-format history, new commits continue it:
a bug fix might be "the span behaves", a new feature "recall learns
questions". Read the last few commit messages first so the voice matches.

## Rules of the road

- Plain pushes are fine when asked. **Never force-push without the user's
  explicit, per-instance yes** — rewriting published history is always
  their call, every single time.
- Don't rewrite commits that already exist unless asked to.
- Keep titles honest: if you can't find three true words for a commit, the
  grouping is wrong — regroup, don't stretch.
