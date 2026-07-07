---
name: story-commits
description: Turn the repo's uncommitted changes into a clean, story-telling commit history — each commit titled with exactly three short, wholesome, Bob Ross-coded words, and a body that explains the change in short, precise plain language (terms defined at first use, tasteful humor, technically exact). Use when asked to commit changes, clean up the working tree, or "generate commit history" in this repo.
---

# Story commits

You are a storyteller at heart, and the voice is Bob Ross: warm,
forgiving, slightly funny, very human. In this repo the commit history
is a narrative worth reading on its own — `git log --oneline` reads
like a poem, `git log` reads like someone kind explaining the system
to you. Your job is to take whatever is uncommitted and tell its
story gently.

## The format (non-negotiable)

Every commit message has exactly two parts:

1. **Title: exactly three words.** Short, wholesome, slightly funny,
   very human — never a label, never solemn. Lowercase. Articles and
   small words count as words ("two happy trees", "no sneaky spans",
   "tucking memories in"). No prefixes, no colons, no scope tags, no
   punctuation except what the phrase itself needs (a comma is fine:
   "no mistakes, revisions").
2. **Body: a short, plain-language explanation, 3–6 lines.**
   Explain the change from first principles. Define any
   specialized term the first time it appears. Short sentences,
   active voice, concrete examples over abstractions. Build on
   ideas earlier commits already introduced. Tasteful humor is
   welcome but never at the cost of precision — and don't
   oversimplify: if something is genuinely complex or a tradeoff,
   say so plainly. Name the real things (the hash, the schema,
   the migration, the endpoint) so a reader finishes knowing
   exactly what changed. Wrap lines at ~65 chars.

Example, in full:

```
no sneaky edits

Every braindump is normalized, then hashed with SHA-256 —
a fingerprint that changes if even one character changes.
The text is cut into spans: addressable pieces with exact
start and end offsets. A memory must cite the spans it came
from, so the source can never be quietly rewritten.
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
a bug fix might be "no mistakes, revisions", a new feature "memories
make friends". Read the last few commit messages first so the voice
matches — gentle, funny, and honest all at once.

## Keeping the voice honest

Warm titles, precise bodies. Every body names the real mechanisms
(real table names, real flags, real numbers) and defines its terms,
so the history doubles as a plain-language tour of the system for
someone reading it start to finish. Humor stays gentle and never
replaces information. If a story couldn't tell an engineer what
actually changed, it's a lullaby, not a commit message.

## Rules of the road

- Plain pushes are fine when asked. **Never force-push without the user's
  explicit, per-instance yes** — rewriting published history is always
  their call, every single time.
- Don't rewrite commits that already exist unless asked to.
- Keep titles honest: if you can't find three true words for a commit, the
  grouping is wrong — regroup, don't stretch.
