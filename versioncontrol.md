# Version Control

## Intent

Version control is how work stays understandable, reviewable, reproducible, and safe to publish.

The point of a good version control flow is not just to save file changes. It is to make sure that:

- changes can be understood in isolation,
- parallel work does not collapse into confusion,
- automation can operate deterministically,
- upstream history stays intentional,
- and rollback or recovery is possible when something goes wrong.

This document focuses on that flow.

## Core Flow

A healthy version control flow has a small number of explicit stages:

1. start from a known repo state,
2. isolate the work,
3. make and verify the change,
4. record the change with a clear history entry,
5. move the intended branch or bookmark to that change,
6. publish only when the result is ready.

If those stages are blurred together, history becomes harder to trust.

## Local History

Local history should be:

- intentional,
- easy to inspect,
- and easy to reshape before publication.

That means:

- make local commits or changesets that represent coherent units of work,
- avoid bundling unrelated changes together,
- prefer a history you can explain without replaying the entire day,
- do not treat local history as disposable noise.

The exact tool can vary, but the flow should preserve those properties.

## Isolation

Before changing code, isolate the work.

Isolation can come from:

- a git branch,
- a jj bookmark,
- a jj workspace,
- or another explicit unit of separation.

The important rule is that separate tasks should not silently share mutable state if they are meant to evolve independently.

When work is parallel, isolation needs to be obvious enough that:

- each change has a clear owner,
- validation can be run against the right filesystem state,
- and publication can happen without guessing which work belongs together.

## Commit Messages

Commit messages should explain intent, not just effect.

A good default is:

- a conventional-style first line,
- followed by a body that explains the reasoning.

A useful first line usually looks like:

```text
type(scope): short specific summary
```

For example:

- `fix(runtime): install the required toolchain for verifier jobs`
- `docs(version-control): explain bookmark publication flow`
- `refactor(workspaces): isolate snapshot logic from push logic`

After the first line, the body should make three things clear.

A good commit message answers:

1. why the change was needed,
2. what goal it achieves,
3. what behavior, invariant, or workflow it improves or protects.

The first line should be short and specific.
The body should carry the reasoning in enough detail that those three questions are answered without outside context.

Conventional Commit structure is useful because it makes history easier to scan, but clarity still matters more than taxonomy. A precise first line with a strong body is better than a perfectly classified but uninformative commit.

Good:

```text
fix(runtime): pin the required toolchain so verification jobs run in the same environment they are supposed to prove

The previous runtime image relied on a system package that lagged behind the
repository's declared toolchain. That made verification fail for infrastructure
reasons instead of proving the actual change.

This update installs the required toolchain explicitly so validation reflects
real feature behavior rather than an avoidable environment mismatch.
```

Bad:

```text
misc fixes
```

## Publication

Publishing should be explicit.

Before publishing:

- the intended history entry should exist,
- the correct branch or bookmark should point to it,
- required verification should have passed,
- and the published state should match the reviewed local state.

Do not rely on implicit HEAD state or vague assumptions about what is being pushed.

The publication step should make it obvious:

- what change is being published,
- where it is being published,
- and why that state is ready.

## Branches And Bookmarks

Branches or bookmarks are coordination pointers.

They should be treated as named references to an intended state, not as casual side effects.

That means:

- move them deliberately,
- avoid leaving them on stale or ambiguous commits,
- and keep remote and local references aligned when publishing upstream.

If a branch or bookmark is supposed to represent a feature, task, or release candidate, it should point at the exact change that matches that claim.

## Workspaces And Parallel Work

Workspaces are useful when multiple streams of work need separate filesystem state while sharing repository history.

A good workspace flow should make it easy to:

- isolate one task from another,
- run verification against the right state,
- snapshot progress without disturbing other work,
- and publish one stream without dragging another along.

When automation or agents are involved, workspace management should be deterministic.

That usually means:

- explicit workspace creation,
- explicit naming,
- explicit snapshot points,
- and explicit movement of publication pointers.

## Automation

Automation should follow the same rules as humans, but more strictly.

Automated systems should not freestyle version control operations.

Instead, they should:

- start from an explicit repository source,
- create isolated work state deliberately,
- record progress through explicit history operations,
- and publish through explicit branch or bookmark movement.

The more autonomous the system is, the more important it becomes that its version control behavior is predictable and inspectable.

## What To Avoid

- mixing unrelated work into one history entry
- publishing changes that have not been verified
- letting automation invent ad hoc version control flows
- hiding important reasoning outside the commit history
- assuming copied repository metadata is a safe substitute for a real clone
- using vague commit messages that do not explain intent

## Practical Standard

A version control flow is working well when all of the following are true:

- you can tell what a change is for,
- you can tell what state is ready to publish,
- you can isolate concurrent work safely,
- automation can reproduce the same flow without guessing,
- and someone else can understand the history without needing private context from the author.
